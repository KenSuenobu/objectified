'use server';

import { generateOpenApiSpec } from '@/app/utils/openapi';
import { STUDIO_EXPORT_OPENAPI_VERSION } from '@/app/utils/openapi-versions';
import { generatePathsForOpenAPI, type PathInfo } from '../utils/openapi-paths-generator';
import { loadPathsForOpenAPIExport } from './helper-paths-export';
import {
  getSecuritySchemesForVersion,
  securitySchemesToOpenAPI,
} from './helper-security-schemes';
import { getServersForVersion, serversToOpenAPI } from './helper-version-servers';
import { isValidVersionBranchName } from '../version-branch-utils';
import { isValidVersionTagName } from '../version-tag-utils';
import { getPlanBlockMessageForNewProject, getPlanBlockMessageForNewVersion } from './plan-entitlements';
import { getAuthSession } from '../auth/server-session';
import { buildGroupMetadataForSync } from '../utils/group-metadata';
import { sortGroupsParentsBeforeChildren } from '../utils/group-sort';
import { normalizeApiKeyScopes } from '@/app/utils/apiKeyScopes';
import { AUTH_ERROR_CODES } from '../auth/account-resolution';
import { upsertCredentialAccountPassword } from './credential-account';

const connectionPool = require('./db');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Helper to standardize error responses
const errorResponse = (error: string) => JSON.stringify({ success: false, error });
const successResponse = (data: any = {}) => JSON.stringify({ success: true, ...data });

/** Max PNG size for canvas layout snapshots (~512 KiB). */
const MAX_CANVAS_LAYOUT_SNAPSHOT_BYTES = 512 * 1024;
/** Max base64-encoded length corresponding to MAX_CANVAS_LAYOUT_SNAPSHOT_BYTES. */
const MAX_CANVAS_LAYOUT_SNAPSHOT_BASE64_CHARS = Math.ceil(MAX_CANVAS_LAYOUT_SNAPSHOT_BYTES / 3) * 4;
/** Full 8-byte PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** 4-byte ASCII chunk type for the required IHDR chunk (first chunk in every PNG). */
const PNG_IHDR_TYPE = Buffer.from([0x49, 0x48, 0x44, 0x52]);
const MAX_LAYOUT_COMMENT_LENGTH = 240;
const MAX_LAYOUT_ANNOTATIONS_LENGTH = 4000;

/**
 * Reserved named layout used when a tenant admin pins a quick snapshot as the team default (#175).
 * Must match the client-side constant TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME in quick-layout-snapshots.ts.
 */
const TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME = 'Team default (quick snapshot)';

function parseLayoutSnapshotBase64(
  snapshotPngBase64: string
): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  let raw = snapshotPngBase64.trim();
  if (raw.startsWith('data:image')) {
    const comma = raw.indexOf(',');
    if (comma !== -1) raw = raw.slice(comma + 1);
  }
  // Reject oversized payloads before decoding to avoid large allocations.
  if (raw.length > MAX_CANVAS_LAYOUT_SNAPSHOT_BASE64_CHARS) {
    return { ok: false, error: 'Layout snapshot exceeds maximum size' };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    return { ok: false, error: 'Invalid layout snapshot encoding' };
  }
  if (buf.length === 0) {
    return { ok: false, error: 'Layout snapshot is empty' };
  }
  if (buf.length > MAX_CANVAS_LAYOUT_SNAPSHOT_BYTES) {
    return { ok: false, error: 'Layout snapshot exceeds maximum size' };
  }
  // Validate full 8-byte PNG signature: \x89PNG\r\n\x1A\n
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, error: 'Layout snapshot must be a PNG image' };
  }
  // Basic PNG structure check: first chunk (at offset 12) must be IHDR
  if (buf.length < 24 || !buf.subarray(12, 16).equals(PNG_IHDR_TYPE)) {
    return { ok: false, error: 'Layout snapshot must be a PNG image' };
  }
  return { ok: true, buffer: buf };
}

/** Strip BYTEA from layout rows before JSON serialization (Buffers are not JSON-safe). */
function layoutRowWithoutBinarySnapshot(row: any) {
  if (!row) return row;
  const { snapshot_image: _s, ...rest } = row;
  return rest;
}

type NamedLayoutAnnotationsInput =
  | {
      comment?: unknown;
      annotations?: unknown;
    }
  | null
  | undefined;

function sanitizeNamedLayoutAnnotations(input: NamedLayoutAnnotationsInput) {
  const rawComment = typeof input?.comment === 'string' ? input.comment.trim() : '';
  const rawAnnotations = typeof input?.annotations === 'string' ? input.annotations.trim() : '';
  const comment = rawComment ? rawComment.slice(0, MAX_LAYOUT_COMMENT_LENGTH) : undefined;
  const annotations = rawAnnotations ? rawAnnotations.slice(0, MAX_LAYOUT_ANNOTATIONS_LENGTH) : undefined;
  return { comment, annotations };
}

/**
 * Look up a live user by email address. The input is canonicalized (trim/lowercase) and compared
 * case-insensitively so lookups match the V180 canonical storage (OLO-1.1: one email, one
 * account). Soft-deleted rows — including duplicates quarantined by the canonicalization
 * migration — never match.
 */
export const getUserByEmail = async (emailAddress: string) =>
  connectionPool.query(
    'SELECT * FROM apiome.users WHERE lower(email) = $1 AND deleted_at IS NULL',
    [String(emailAddress ?? '').trim().toLowerCase()]
  );

export const getUserById = async (userId: string) =>
  connectionPool.query('SELECT * FROM apiome.users WHERE id = $1 AND deleted_at IS NULL', [userId]);

const emptyStats = {
  total_tenants: 0, admin_tenants: 0, total_projects: 0, created_projects: 0,
  total_versions: 0, created_versions: 0, published_versions: 0, total_classes: 0,
  total_properties: 0, total_class_properties: 0, last_activity: null
};

export async function getDashboardStats(userId: string) {
  try {
    const userTenants = '(SELECT tenant_id FROM apiome.tenant_users WHERE user_id = $1)';
    const result = await connectionPool.query(
      `SELECT 
        (SELECT COUNT(DISTINCT tenant_id) FROM apiome.tenant_users WHERE user_id = $1) as total_tenants,
        (SELECT COUNT(DISTINCT tenant_id) FROM apiome.tenant_administrators WHERE user_id = $1) as admin_tenants,
        (SELECT COUNT(DISTINCT p.id) FROM apiome.projects p WHERE p.tenant_id IN ${userTenants} AND p.deleted_at IS NULL) as total_projects,
        (SELECT COUNT(*) FROM apiome.projects WHERE creator_id = $1 AND deleted_at IS NULL) as created_projects,
        (SELECT COUNT(DISTINCT v.id) FROM apiome.versions v JOIN apiome.projects p ON v.project_id = p.id WHERE p.tenant_id IN ${userTenants} AND v.deleted_at IS NULL) as total_versions,
        (SELECT COUNT(*) FROM apiome.versions WHERE creator_id = $1 AND deleted_at IS NULL) as created_versions,
        (SELECT COUNT(DISTINCT v.id) FROM apiome.versions v JOIN apiome.projects p ON v.project_id = p.id WHERE p.tenant_id IN ${userTenants} AND v.published = true AND v.deleted_at IS NULL) as published_versions,
        (SELECT COUNT(DISTINCT c.id) FROM apiome.classes c JOIN apiome.versions v ON c.version_id = v.id JOIN apiome.projects p ON v.project_id = p.id WHERE p.tenant_id IN ${userTenants} AND c.deleted_at IS NULL AND v.deleted_at IS NULL) as total_classes,
        (SELECT COUNT(DISTINCT pr.id) FROM apiome.properties pr JOIN apiome.projects p ON pr.project_id = p.id WHERE p.tenant_id IN ${userTenants} AND pr.deleted_at IS NULL) as total_properties,
        (SELECT COUNT(DISTINCT cp.id) FROM apiome.class_properties cp JOIN apiome.classes c ON cp.class_id = c.id JOIN apiome.versions v ON c.version_id = v.id JOIN apiome.projects p ON v.project_id = p.id WHERE p.tenant_id IN ${userTenants} AND c.deleted_at IS NULL AND v.deleted_at IS NULL) as total_class_properties,
        (SELECT MAX(created_at) FROM (SELECT created_at FROM apiome.projects WHERE creator_id = $1 UNION ALL SELECT created_at FROM apiome.versions WHERE creator_id = $1 UNION ALL SELECT c.created_at FROM apiome.classes c JOIN apiome.versions v ON c.version_id = v.id WHERE v.creator_id = $1 AND c.deleted_at IS NULL) activities) as last_activity`,
      [userId]
    );
    return JSON.stringify(result.rows[0]);
  } catch (error: any) {
    console.error('Error fetching dashboard stats:', error);
    return JSON.stringify(emptyStats);
  }
}

export async function getRecentActivity(userId: string, limit: number = 10) {
  try {
    const result = await connectionPool.query(
      `SELECT * FROM (
        SELECT 'project' as type, p.id, p.name, p.description, p.created_at, t.name as tenant_name, t.slug as tenant_slug
        FROM apiome.projects p JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE p.creator_id = $1 AND p.deleted_at IS NULL
        UNION ALL
        SELECT 'version' as type, v.id, v.version_id as name, v.description, v.created_at, t.name as tenant_name, t.slug as tenant_slug
        FROM apiome.versions v JOIN apiome.projects p ON v.project_id = p.id JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE v.creator_id = $1 AND v.deleted_at IS NULL
        UNION ALL
        SELECT 'class' as type, c.id, c.name, c.description, c.created_at, t.name as tenant_name, t.slug as tenant_slug
        FROM apiome.classes c JOIN apiome.versions v ON c.version_id = v.id JOIN apiome.projects p ON v.project_id = p.id JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE p.creator_id = $1 AND c.deleted_at IS NULL AND v.deleted_at IS NULL
        UNION ALL
        SELECT 'property' as type, pr.id, pr.name, pr.description, pr.created_at, t.name as tenant_name, t.slug as tenant_slug
        FROM apiome.properties pr JOIN apiome.projects p ON pr.project_id = p.id JOIN apiome.tenants t ON p.tenant_id = t.id
        WHERE p.creator_id = $1 AND pr.deleted_at IS NULL
      ) activities ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching recent activity:', error);
    return JSON.stringify([]);
  }
}

export async function getTenantsForUser(userId: string) {
  const result = await connectionPool.query(
    `SELECT DISTINCT a.*
     FROM apiome.tenants a
     INNER JOIN (
       SELECT tenant_id FROM apiome.tenant_users WHERE user_id = $1
       UNION
       SELECT tenant_id FROM apiome.tenant_administrators WHERE user_id = $1
     ) access ON access.tenant_id = a.id
     WHERE a.deleted_at IS NULL`,
    [userId]
  );
  return JSON.stringify(result.rows);
}

/**
 * Tenants where the user holds a *live* membership per the V121 lifecycle
 * (OLO-4.4, #4208): a `tenant_users` row with status `active` or `pending`,
 * or a legacy `tenant_administrators` entry (admins count as active).
 * Suspended memberships are excluded — a suspended row must neither route the
 * user into the tenant nor count as a membership for onboarding.
 *
 * @param userId The `apiome.users.id` to look up.
 * @returns JSON array of `{ id, name, status }` rows; when a user has both an
 *   admin entry and a member row, `active` wins over `pending`.
 */
export async function getTenantMembershipsForUser(userId: string) {
  const result = await connectionPool.query(
    `SELECT DISTINCT ON (a.id) a.id, a.name, access.status
     FROM apiome.tenants a
     INNER JOIN (
       SELECT tenant_id, status FROM apiome.tenant_users
        WHERE user_id = $1 AND status IN ('active', 'pending')
       UNION
       SELECT tenant_id, 'active' AS status FROM apiome.tenant_administrators WHERE user_id = $1
     ) access ON access.tenant_id = a.id
     WHERE a.deleted_at IS NULL
     ORDER BY a.id, access.status`,
    [userId]
  );
  return JSON.stringify(result.rows);
}

export async function getTenantById(tenantId: string) {
  const result = await connectionPool.query(
    'SELECT id, name, slug, description, enabled FROM apiome.tenants WHERE id = $1 AND deleted_at IS NULL',
    [tenantId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Whether a tenant slug is already in use (HIVE-4.3, #5297).
 *
 * The same question `createTenant` asks before inserting, exposed as a read so
 * a sign-up form can answer it before the reader presses the button. Soft-deleted
 * tenants do not hold their slug, matching the uniqueness rule the insert applies.
 *
 * Callers are responsible for shape-validating and normalizing the slug first
 * (`validateTenantSlug`), and for deciding who is allowed to ask — this function
 * is a plain lookup with no authorization of its own.
 *
 * @param slug Candidate slug, already trimmed and lowercased.
 * @returns True when a live tenant holds this slug.
 */
export async function isTenantSlugTaken(slug: string): Promise<boolean> {
  const normalized = String(slug ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const result = await connectionPool.query(
    'SELECT 1 FROM apiome.tenants WHERE slug = $1 AND deleted_at IS NULL LIMIT 1',
    [normalized]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getTenantsAdministratedByUser(userId: string) {
  const result = await connectionPool.query(
    `SELECT ta.id, ta.tenant_id, ta.user_id, u.name, u.email
     FROM apiome.tenant_administrators ta
     INNER JOIN apiome.users u ON u.id = ta.user_id
     WHERE ta.user_id = $1`,
    [userId]
  );
  return JSON.stringify(result.rows);
}

/** True when the user is in apiome.tenant_administrators for this tenant (source of truth for admin role). */
export async function isUserTenantAdministrator(userId: string, tenantId: string): Promise<boolean> {
  if (!String(userId ?? '').trim() || !String(tenantId ?? '').trim()) return false;
  const r = await connectionPool.query(
    `SELECT 1 FROM apiome.tenant_administrators WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
    [userId, tenantId]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Prefer JWT is_tenant_admin; if false/missing, fall back to DB so API matches Versions dashboard effectiveIsAdmin
 * (session token can be stale after admin promotion).
 */
export async function resolveTenantAdminForSession(
  userId: string | undefined,
  tenantId: string | undefined,
  jwtIsTenantAdmin: boolean | undefined
): Promise<boolean> {
  if (jwtIsTenantAdmin) return true;
  if (!userId || !tenantId) return false;
  return isUserTenantAdministrator(userId, tenantId);
}

export async function getTenantUsers(tenantId: string) {
  const result = await connectionPool.query(
    `SELECT a.id, a.tenant_id, a.user_id, b.name, b.email FROM apiome.tenant_users a, apiome.users b 
     WHERE b.id = a.user_id AND a.tenant_id = $1`,
    [tenantId]);
  return JSON.stringify(result.rows);
}

export async function addTenantAdministrator(tenantId: string, userEmail: string) {
  try {
    const userResult = await connectionPool.query('SELECT id FROM apiome.users WHERE email = $1', [userEmail]);
    if (userResult.rowCount === 0) return errorResponse('User not found');

    const userId = userResult.rows[0].id;
    const existingAdmin = await connectionPool.query(
      'SELECT id FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    if (existingAdmin.rowCount > 0) return errorResponse('User is already an administrator');

    await connectionPool.query('INSERT INTO apiome.tenant_administrators (tenant_id, user_id) VALUES ($1, $2)', [tenantId, userId]);

    // Ensure user is also in tenant_users
    const existingUser = await connectionPool.query(
      'SELECT id FROM apiome.tenant_users WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    if (existingUser.rowCount === 0) {
      await connectionPool.query('INSERT INTO apiome.tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenantId, userId]);
    }

    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function addTenantUser(tenantId: string, userEmail: string) {
  try {
    const userResult = await connectionPool.query('SELECT id FROM apiome.users WHERE email = $1', [userEmail]);
    if (userResult.rowCount === 0) return errorResponse('User not found');

    const userId = userResult.rows[0].id;
    const existingUser = await connectionPool.query(
      'SELECT id FROM apiome.tenant_users WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    if (existingUser.rowCount > 0) return errorResponse('User is already a member of this tenant');

    await connectionPool.query('INSERT INTO apiome.tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenantId, userId]);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function removeTenantAdministrator(adminRecordId: string) {
  try {
    await connectionPool.query('DELETE FROM apiome.tenant_administrators WHERE id = $1', [adminRecordId]);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function removeTenantUser(userRecordId: string) {
  try {
    await connectionPool.query('DELETE FROM apiome.tenant_users WHERE id = $1', [userRecordId]);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

const slugRegex = /^[a-z0-9-]+$/;
const generateSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');

const validateSlug = (slug: string) => {
  if (!slugRegex.test(slug)) return 'Slug must contain only lowercase letters, numbers, and dashes';
  return null;
};

export async function updateTenant(tenantId: string, name: string, description: string, customSlug?: string) {
  try {
    if (!name?.trim()) return errorResponse('Tenant name cannot be empty');

    const slug = customSlug?.trim() || generateSlug(name);
    const slugError = validateSlug(slug);
    if (slugError) return errorResponse(slugError);

    const existingTenant = await connectionPool.query(
      'SELECT id FROM apiome.tenants WHERE slug = $1 AND id != $2', [slug, tenantId]);
    if (existingTenant.rowCount > 0) return errorResponse('A tenant with this slug already exists');

    await connectionPool.query(
      'UPDATE apiome.tenants SET name = $1, slug = $2, description = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      [name.trim(), slug, description.trim(), tenantId]);
    return successResponse({ slug });
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function updateUserName(userId: string, name: string) {
  try {
    if (!name?.trim()) return errorResponse('Name cannot be empty');
    await connectionPool.query('UPDATE apiome.users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [name.trim(), userId]);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

/** Persists successful login time for the user (credentials or OAuth). Errors are logged only; login must not fail. */
export async function updateUserLastLoginAt(userId: string) {
  try {
    await connectionPool.query(
      'UPDATE apiome.users SET last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );
  } catch (error: any) {
    console.error('Error updating user last_login_at:', error);
  }
}

export async function getCurrentUserLastLoginAt() {
  try {
    const session = await getAuthSession();
    const userId = (session?.user as any)?.user_id;
    if (!userId) {
      return errorResponse('Unauthorized');
    }
    const result = await connectionPool.query(
      'SELECT last_login_at FROM apiome.users WHERE id = $1 AND deleted_at IS NULL',
      [userId]
    );
    if (!result.rowCount) {
      return errorResponse('User not found');
    }
    return successResponse({ lastLoginAt: result.rows[0].last_login_at });
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

const validatePassword = (password: string) => {
  if (!password || password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one number or special character';
  return null;
};

export async function updateUserPassword(userId: string, currentPassword: string, newPassword: string) {
  try {
    const validationError = validatePassword(newPassword);
    if (validationError) return errorResponse(validationError);

    const userResult = await connectionPool.query('SELECT password FROM apiome.users WHERE id = $1', [userId]);
    if (userResult.rowCount === 0) return errorResponse('User not found');

    const isPasswordValid = await bcrypt.compare(currentPassword, userResult.rows[0].password);
    if (!isPasswordValid) return errorResponse('Current password is incorrect');

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    await connectionPool.query('UPDATE apiome.users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newPasswordHash, userId]);
    // Mirror the new bcrypt hash into the Better Auth credential account row (OLO-10.5) so a cutover
    // to Better Auth authenticates against the just-changed password. Best-effort; users.password
    // above stays the authoritative rollback source.
    await upsertCredentialAccountPassword(userId, newPasswordHash);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

// Project Management Functions

/**
 * @deprecated This function has been replaced with REST API calls.
 * Use `/api/projects` endpoint instead for fetching projects.
 * This function is kept for backward compatibility but should not be used in new code.
 * 
 * To fetch projects, use:
 * ```typescript
 * const response = await fetch('/api/projects');
 * const data = await response.json();
 * if (data.success && data.projects) {
 *   // Use data.projects
 * }
 * ```
 */
export async function getProjectsForTenant(tenantId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT p.*, u.name as creator_name, u.email as creator_email FROM apiome.projects p 
       LEFT JOIN apiome.users u ON p.creator_id = u.id WHERE p.tenant_id = $1 AND p.deleted_at IS NULL ORDER BY p.created_at DESC`,
      [tenantId]);
    return JSON.stringify(result.rows);
  } catch (error: any) {
    return JSON.stringify([]);
  }
}

export async function createProject(tenantId: string, creatorId: string, name: string, description: string, slug: string, metadata?: any) {
  try {
    if (!name?.trim()) return errorResponse('Project name is required');
    if (!slug?.trim()) return errorResponse('Project slug is required');
    const slugError = validateSlug(slug.trim());
    if (slugError) return errorResponse(slugError);

    const session = await getAuthSession();
    const sessionUserId = (session?.user as any)?.user_id;
    if (!sessionUserId) return errorResponse('Unauthorized');
    if (sessionUserId !== creatorId) return errorResponse('Unauthorized');

    const planErr = await getPlanBlockMessageForNewProject(sessionUserId);
    if (planErr) return errorResponse(planErr);

    const result = await connectionPool.query(
      `INSERT INTO apiome.projects (tenant_id, creator_id, name, description, slug, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, creatorId, name.trim(), description?.trim() || null, slug.trim().toLowerCase(), metadata ? JSON.stringify(metadata) : '{}']);
    return successResponse({ project: result.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') return errorResponse('A project with this slug already exists in this tenant');
    return errorResponse(error.message);
  }
}

export async function updateProject(projectId: string, name: string, description: string, slug: string, enabled: boolean, metadata?: any) {
  try {
    if (!name?.trim()) return errorResponse('Project name is required');
    if (!slug?.trim()) return errorResponse('Project slug is required');
    const slugError = validateSlug(slug.trim());
    if (slugError) return errorResponse(slugError);

    await connectionPool.query(
      `UPDATE apiome.projects SET name = $1, description = $2, slug = $3, enabled = $4, metadata = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 AND deleted_at IS NULL`,
      [name.trim(), description?.trim() || null, slug.trim().toLowerCase(), enabled, metadata ? JSON.stringify(metadata) : '{}', projectId]);
    return successResponse();
  } catch (error: any) {
    if (error.code === '23505') return errorResponse('A project with this slug already exists in this tenant');
    return errorResponse(error.message);
  }
}

export async function deleteProject(projectId: string) {
  try {
    await connectionPool.query(
      `UPDATE apiome.projects SET pre_delete_enabled = enabled, enabled = false, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL`,
      [projectId]);
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function restoreProject(projectId: string) {
  try {
    const result = await connectionPool.query(
      `UPDATE apiome.projects SET deleted_at = NULL, enabled = COALESCE(pre_delete_enabled, TRUE), pre_delete_enabled = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NOT NULL`,
      [projectId]
    );
    if (!result.rowCount) {
      return errorResponse('Project not found or not deleted');
    }
    return successResponse();
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

export async function permanentDeleteProject(projectId: string) {
  try {
    // Begin transaction to ensure all related data is deleted atomically
    const client = await connectionPool.connect();
    try {
      await client.query('BEGIN');

      // Get all version IDs for this project
      const versionsResult = await client.query(
        `SELECT id FROM apiome.versions WHERE project_id = $1`,
        [projectId]
      );
      const versionIds = versionsResult.rows.map((row: any) => row.id);

      if (versionIds.length > 0) {
        // Get all class IDs for these versions
        const classesResult = await client.query(
          `SELECT id FROM apiome.classes WHERE version_id = ANY($1)`,
          [versionIds]
        );
        const classIds = classesResult.rows.map((row: any) => row.id);

        if (classIds.length > 0) {
          // shared_path_response.class_id -> classes ON DELETE SET NULL. Rows that only defined
          // schema via class_id would have all of (class_id, inline_schema, data) null after the
          // FK update and violate check_response_schema_defined. Ensure legacy `data` is set first.
          await client.query(
            `UPDATE apiome.shared_path_response
             SET data = COALESCE(data, '{}'::jsonb)
             WHERE class_id = ANY($1::uuid[])
               AND data IS NULL
               AND inline_schema IS NULL`,
            [classIds]
          );

          // Same pattern: request body content uses class_id OR inline_schema (request_body_content_schema_check).
          await client.query(
            `UPDATE apiome.shared_path_request_body_content
             SET inline_schema = COALESCE(
               inline_schema,
               '{"type":"object","properties":[]}'::jsonb
             )
             WHERE class_id = ANY($1::uuid[])
               AND inline_schema IS NULL`,
            [classIds]
          );

          // Delete all class_properties for these classes
          await client.query(
            `DELETE FROM apiome.class_properties WHERE class_id = ANY($1)`,
            [classIds]
          );

          // Delete all classes for these versions
          await client.query(
            `DELETE FROM apiome.classes WHERE version_id = ANY($1)`,
            [versionIds]
          );
        }

        // Delete all versions for this project
        await client.query(
          `DELETE FROM apiome.versions WHERE project_id = $1`,
          [projectId]
        );
      }

      // Delete all properties directly linked to the project
      await client.query(
        `DELETE FROM apiome.properties WHERE project_id = $1`,
        [projectId]
      );

      // Finally, delete the project itself
      await client.query(
        `DELETE FROM apiome.projects WHERE id = $1`,
        [projectId]
      );

      await client.query('COMMIT');
      return successResponse();
    } catch (error: any) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    return errorResponse(error.message);
  }
}

// Version Management Functions

/**
 * @deprecated This function has been replaced by REST API calls.
 * Use `/api/versions?projectId=${projectId}` endpoint instead.
 * 
 * Example:
 * const response = await fetch(`/api/versions?projectId=${projectId}`);
 * const data = await response.json();
 * if (data.success && data.versions) {
 *   // Use data.versions
 * }
 * 
 * This function is kept for backward compatibility and testing purposes only.
 */
export async function getVersionsForProject(projectId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT v.*, u.name as creator_name, u.email as creator_email FROM apiome.versions v 
       LEFT JOIN apiome.users u ON v.creator_id = u.id WHERE v.project_id = $1 AND v.deleted_at IS NULL ORDER BY v.created_at DESC`,
      [projectId]);
    return JSON.stringify(result.rows);
  } catch (error: any) {
    return JSON.stringify([]);
  }
}

export async function getLatestVersionForProject(projectId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT version_id FROM apiome.versions WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [projectId]);
    return result.rowCount > 0 ? result.rows[0].version_id : null;
  } catch (error: any) {
    return null;
  }
}

/**
 * Get a version by its record id (UUID). Returns id and version_id string for use in sub-version creation (#590).
 */
export async function getVersionById(versionRecordId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, version_id FROM apiome.versions WHERE id = $1 AND deleted_at IS NULL`,
      [versionRecordId]
    );
    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Version not found' });
    }
    const row = result.rows[0];
    return JSON.stringify({ success: true, id: row.id, version_id: row.version_id });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

const parseSemanticVersion = (version: string) => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) } : null;
};

/** Accept X.Y.Z or X.Y.Z with prerelease (e.g. 1.0.0b, 1.0.0-beta). Used for createVersion when allowing sub-versions (#590). */
const parseSemanticVersionWithPrerelease = (version: string) => {
  const strict = parseSemanticVersion(version);
  if (strict) return true;
  const withPrerelease = version.match(/^(\d+)\.(\d+)\.(\d+)([-a-zA-Z0-9.]*)$/);
  return withPrerelease != null && withPrerelease[4].length > 0;
};

/**
 * Derive base numeric version (X.Y.Z) from a version string that may include prerelease (e.g. 1.0.0b -> 1.0.0).
 */
const getBaseVersion = (version: string): string => {
  const parsed = parseSemanticVersion(version);
  if (parsed) return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '0.1.0';
};

/**
 * Create a sub-version identifier from a base version (e.g. 1.0.0 + "b" -> 1.0.0b). Used for "import as new version" (#590).
 * Async to satisfy Server Actions (file has 'use server').
 */
export async function bumpPrereleaseVersion(baseVersionId: string, suffix: string): Promise<string> {
  const base = getBaseVersion(baseVersionId);
  const s = (suffix || 'b').trim().replace(/^[-.]/, '');
  return s ? `${base}${s}` : `${base}b`;
}

const bumpMinorVersion = (version: string) => {
  const parsed = parseSemanticVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor + 1}.0` : '0.1.0';
};

const bumpPatchVersion = (version: string) => {
  const parsed = parseSemanticVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}` : '0.1.0';
};

export async function copyClassesFromVersion(sourceVersionId: string, targetVersionId: string) {
  try {
    // Copy all classes from source version to target version (including canvas_metadata for layout preservation)
    const result = await connectionPool.query(
      `INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
       SELECT $1, name, description, schema, enabled, canvas_metadata
       FROM apiome.classes
       WHERE version_id = $2 AND deleted_at IS NULL
       RETURNING id, name`,
      [targetVersionId, sourceVersionId]
    );

    const copiedClasses = result.rows;

    // For each copied class, copy its properties
    for (const copiedClass of copiedClasses) {
      // Find the original class by name in the source version
      const originalClassResult = await connectionPool.query(
        `SELECT id FROM apiome.classes
         WHERE version_id = $1 AND name = $2 AND deleted_at IS NULL`,
        [sourceVersionId, copiedClass.name]
      );

      if (originalClassResult.rowCount > 0) {
        const originalClassId = originalClassResult.rows[0].id;
        const newClassId = copiedClass.id;

        // Copy all class properties (including parent_id for nested properties)
        // We need to map old property IDs to new ones to maintain parent-child relationships

        // First, get all properties from the original class
        const originalPropertiesResult = await connectionPool.query(
          `SELECT id, property_id, name, description, data, parent_id
           FROM apiome.class_properties
           WHERE class_id = $1`,
          [originalClassId]
        );

        const oldToNewIdMap = new Map<string, string>();
        const allProperties = originalPropertiesResult.rows;
        const processedIds = new Set<string>();

        // Recursive function to copy properties level by level (breadth-first)
        // This ensures parent properties are created before their children
        const copyPropertiesRecursively = async (parentId: string | null) => {
          // Find all properties with the given parent_id
          const propsAtThisLevel = allProperties.filter(
            (p: any) => (p.parent_id === parentId || (p.parent_id === null && parentId === null)) && !processedIds.has(p.id)
          );

          // Copy each property at this level
          for (const prop of propsAtThisLevel) {
            // Resolve the new parent_id (will be null for top-level, or mapped ID for nested)
            const newParentId = prop.parent_id ? oldToNewIdMap.get(prop.parent_id) || null : null;

            // Insert the property with the updated parent_id
            const insertResult = await connectionPool.query(
              `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id`,
              [newClassId, prop.property_id, prop.name, prop.description, prop.data, newParentId]
            );

            // Map the old property ID to the new one
            const newId = insertResult.rows[0].id;
            oldToNewIdMap.set(prop.id, newId);
            processedIds.add(prop.id);

            // Recursively copy children of this property
            await copyPropertiesRecursively(prop.id);
          }
        };

        // Start with top-level properties (parent_id = null)
        await copyPropertiesRecursively(null);
      }
    }

    return JSON.stringify({ success: true, copiedCount: copiedClasses.length });
  } catch (error: any) {
    console.error('Error copying classes from version:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** Rewrite `#/components/schemas/{Name}` refs when duplicating a set of classes with new names (#156). */
function rewriteOpenApiRefsInValue(value: unknown, oldNameToNewName: Map<string, string>): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => rewriteOpenApiRefsInValue(item, oldNameToNewName));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (typeof out['$ref'] === 'string') {
      const ref = out['$ref'] as string;
      const prefix = '#/components/schemas/';
      if (ref.startsWith(prefix)) {
        const oldName = ref.slice(prefix.length);
        const newName = oldNameToNewName.get(oldName);
        if (newName) {
          out['$ref'] = `${prefix}${newName}`;
        }
      }
    }
    for (const key of Object.keys(out)) {
      if (key === '$ref') continue;
      out[key] = rewriteOpenApiRefsInValue(out[key], oldNameToNewName);
    }
    return out;
  }
  return value;
}

function makeUniqueCopyName(stem: string, taken: Set<string>): string {
  const base = stem.trim() || 'Class';
  let candidate = `${base} Copy`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base} Copy ${n}`;
    n += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Deep-duplicate classes in the same version (new rows, new names, refs between them rewritten).
 * Used for "duplicate group" on the canvas (#156).
 */
export async function duplicateClassesInGroup(versionId: string, sourceClassIds: string[]) {
  const client = await connectionPool.connect();
  try {
    const uniqueIds = [...new Set((sourceClassIds || []).filter(Boolean))];
    if (uniqueIds.length === 0) {
      client.release();
      return JSON.stringify({ success: true, idMap: {} });
    }

    await client.query('BEGIN');

    const classesResult = await client.query(
      `SELECT id, name, description, schema, enabled
       FROM apiome.classes
       WHERE version_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [versionId, uniqueIds]
    );

    if (classesResult.rowCount !== uniqueIds.length) {
      await client.query('ROLLBACK');
      return JSON.stringify({
        success: false,
        error: 'One or more classes were not found in this version.',
      });
    }

    const existingNamesResult = await client.query(
      `SELECT name FROM apiome.classes WHERE version_id = $1 AND deleted_at IS NULL`,
      [versionId]
    );
    const takenNames = new Set<string>(
      existingNamesResult.rows.map((r: { name: string }) => r.name)
    );

    const rows = classesResult.rows as Array<{
      id: string;
      name: string;
      description: string | null;
      schema: unknown;
      enabled: boolean;
    }>;

    const oldNameToNewName = new Map<string, string>();
    for (const row of rows) {
      const newName = makeUniqueCopyName(row.name, takenNames);
      oldNameToNewName.set(row.name, newName);
    }

    const idMap: Record<string, string> = {};

    for (const row of rows) {
      const newName = oldNameToNewName.get(row.name)!;
      let schemaObj =
        typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema || {};
      schemaObj = rewriteOpenApiRefsInValue(schemaObj, oldNameToNewName) as Record<string, unknown>;

      const insertResult = await client.query(
        `INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          versionId,
          newName,
          row.description,
          JSON.stringify(schemaObj),
          row.enabled ?? true,
          null,
        ]
      );

      const newId = insertResult.rows[0].id as string;
      idMap[row.id] = newId;

      const originalPropertiesResult = await client.query(
        `SELECT id, property_id, name, description, data, parent_id
         FROM apiome.class_properties
         WHERE class_id = $1
         ORDER BY parent_id NULLS FIRST, name ASC`,
        [row.id]
      );

      const allProperties = originalPropertiesResult.rows;
      const oldToNewIdMap = new Map<string, string>();
      const processedIds = new Set<string>();

      const copyPropertiesRecursively = async (parentId: string | null) => {
        const propsAtThisLevel = allProperties.filter(
          (p: any) =>
            (p.parent_id === parentId || (p.parent_id === null && parentId === null)) &&
            !processedIds.has(p.id)
        );

        for (const prop of propsAtThisLevel) {
          const newParentId = prop.parent_id ? oldToNewIdMap.get(prop.parent_id) || null : null;
          let dataVal: unknown = prop.data;
          if (typeof dataVal === 'string') {
            try {
              dataVal = JSON.parse(dataVal);
            } catch {
              /* keep primitive string data as-is */
            }
          }
          if (dataVal !== null && typeof dataVal === 'object') {
            dataVal = rewriteOpenApiRefsInValue(dataVal, oldNameToNewName);
          }

          const dataForInsert =
            typeof dataVal === 'string' ? dataVal : JSON.stringify(dataVal ?? {});

          const insertProp = await client.query(
            `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [newId, prop.property_id, prop.name, prop.description, dataForInsert, newParentId]
          );

          const newPropId = insertProp.rows[0].id as string;
          oldToNewIdMap.set(prop.id, newPropId);
          processedIds.add(prop.id);
          await copyPropertiesRecursively(prop.id);
        }
      };

      await copyPropertiesRecursively(null);

      await client.query(
        `INSERT INTO apiome.class_tags (class_id, tag_id)
         SELECT $1, tag_id FROM apiome.class_tags WHERE class_id = $2
         ON CONFLICT (class_id, tag_id) DO NOTHING`,
        [newId, row.id]
      );
    }

    await client.query('COMMIT');
    return JSON.stringify({ success: true, idMap });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('duplicateClassesInGroup:', error);
    return JSON.stringify({ success: false, error: error.message });
  } finally {
    client.release();
  }
}

/**
 * Apply bulk metadata / tag / top-level property flag changes to many classes (#156).
 * `versionId` is required so the function validates that all class IDs belong to that version.
 */
export async function bulkApplyEditsToGroupClasses(
  versionId: string,
  classIds: string[],
  options: {
    descriptionPrefix?: string;
    descriptionSuffix?: string;
    tagId?: string;
    topLevelPropertyReadOnly?: boolean;
  }
) {
  try {
    const uniqueIds = [...new Set((classIds || []).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return JSON.stringify({ success: true });
    }

    // Validate that all requested IDs belong to the given version
    const ownedResult = await connectionPool.query(
      `SELECT id FROM apiome.classes WHERE version_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [versionId, uniqueIds]
    );
    const ownedIds = new Set<string>(ownedResult.rows.map((r: { id: string }) => r.id));
    const validIds = uniqueIds.filter((id) => ownedIds.has(id));
    if (validIds.length === 0) {
      return JSON.stringify({ success: false, error: 'No valid class IDs for this version.' });
    }

    const prefix = options.descriptionPrefix ?? '';
    const suffix = options.descriptionSuffix ?? '';

    if (prefix !== '' || suffix !== '') {
      for (const classId of validIds) {
        const r = await connectionPool.query(
          `SELECT id, name, description, schema FROM apiome.classes WHERE id = $1 AND deleted_at IS NULL`,
          [classId]
        );
        if (r.rowCount === 0) continue;
        const row = r.rows[0];
        const desc = `${prefix}${row.description || ''}${suffix}`;
        const schema = typeof row.schema === 'string' ? JSON.parse(row.schema) : row.schema;
        await updateClass(row.id, row.name, desc.trim() === '' ? null : desc, schema);
      }
    }

    if (options.tagId) {
      for (const classId of validIds) {
        await assignTagToClass(classId, options.tagId);
      }
    }

    if (typeof options.topLevelPropertyReadOnly === 'boolean') {
      const ro = options.topLevelPropertyReadOnly;
      await connectionPool.query('BEGIN');
      try {
        for (const classId of validIds) {
          const props = await connectionPool.query(
            `SELECT id, data FROM apiome.class_properties WHERE class_id = $1 AND parent_id IS NULL`,
            [classId]
          );
          for (const p of props.rows) {
            let data: Record<string, unknown>;
            try {
              data =
                typeof p.data === 'string'
                  ? JSON.parse(p.data || '{}')
                  : { ...(p.data as object) };
            } catch {
              data = {};
            }
            if (ro) data.readOnly = true;
            else delete data.readOnly;
            await connectionPool.query(`UPDATE apiome.class_properties SET data = $1 WHERE id = $2`, [
              JSON.stringify(data),
              p.id,
            ]);
          }
        }
        await connectionPool.query('COMMIT');
      } catch (e) {
        await connectionPool.query('ROLLBACK');
        throw e;
      }
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('bulkApplyEditsToGroupClasses:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function createVersion(projectId: string, creatorId: string, versionId: string | null, description: string, changeLog: string, sourceVersionId?: string | null, bumpStrategy?: 'patch' | 'minor') {
  try {
    let finalVersionId = versionId;

    // If no version ID provided, auto-generate by bumping the latest version
    if (!finalVersionId || finalVersionId.trim().length === 0) {
      const latestVersion = await getLatestVersionForProject(projectId);
      if (latestVersion) {
        // Use the provided bump strategy, default to 'patch' if not specified
        finalVersionId = (bumpStrategy === 'minor')
          ? bumpMinorVersion(latestVersion)
          : bumpPatchVersion(latestVersion);
      } else {
        finalVersionId = '0.1.0';
      }
    }

    // Validate semantic versioning format (X.Y.Z or X.Y.Z with prerelease, e.g. 1.0.0b)
    if (!parseSemanticVersion(finalVersionId) && !parseSemanticVersionWithPrerelease(finalVersionId)) {
      return JSON.stringify({ success: false, error: 'Version ID must follow semantic versioning format (e.g., 1.0.0 or 1.0.0b)' });
    }

    const session = await getAuthSession();
    const sessionUserId = (session?.user as any)?.user_id;
    if (!sessionUserId) return JSON.stringify({ success: false, error: 'Unauthorized' });
    if (sessionUserId !== creatorId) return JSON.stringify({ success: false, error: 'Unauthorized' });

    const planErr = await getPlanBlockMessageForNewVersion(sessionUserId);
    if (planErr) return JSON.stringify({ success: false, error: planErr });

    const result = await connectionPool.query(
      `INSERT INTO apiome.versions (project_id, creator_id, version_id, description, change_log)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [projectId, creatorId, finalVersionId.trim(), description?.trim() || null, changeLog?.trim() || null]
    );

    const newVersion = result.rows[0];

    // If a source version was provided, copy its classes and properties
    if (sourceVersionId && sourceVersionId.trim().length > 0) {
      const copyResult = await copyClassesFromVersion(sourceVersionId, newVersion.id);
      const copyResponse = JSON.parse(copyResult);

      if (!copyResponse.success) {
        // If copy fails, still return success but include warning
        return JSON.stringify({
          success: true,
          version: newVersion,
          copyWarning: copyResponse.error
        });
      }

      return JSON.stringify({
        success: true,
        version: newVersion,
        copiedClasses: copyResponse.copiedCount
      });
    }

    return JSON.stringify({ success: true, version: newVersion });
  } catch (error: any) {
    if (error.code === '23505') { // Unique constraint violation
      return JSON.stringify({ success: false, error: 'A version with this ID already exists for this project' });
    }
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateVersion(versionRecordId: string, description: string, changeLog: string, enabled: boolean) {
  try {
    // Check if version is published (frozen)
    const versionCheck = await connectionPool.query(
      'SELECT published FROM apiome.versions WHERE id = $1 AND deleted_at IS NULL',
      [versionRecordId]
    );

    if (versionCheck.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Version not found' });
    }

    if (versionCheck.rows[0].published) {
      return JSON.stringify({ success: false, error: 'Cannot edit a published version. Published versions are frozen.' });
    }

    await connectionPool.query(
      `UPDATE apiome.versions 
       SET description = $1, change_log = $2, enabled = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND deleted_at IS NULL`,
      [description?.trim() || null, changeLog?.trim() || null, enabled, versionRecordId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function publishVersion(versionRecordId: string, userId: string, visibility: 'public' | 'private' = 'private') {
  try {
    const visibilityValue = visibility === 'public' ? 'public' : 'private';
    const result = await connectionPool.query(
      `UPDATE apiome.versions v
       SET published = true, published_at = CURRENT_TIMESTAMP, visibility = $3, updated_at = CURRENT_TIMESTAMP
       WHERE v.id = $1
         AND v.deleted_at IS NULL
         AND (
           v.creator_id = $2
           OR EXISTS (
             SELECT 1
             FROM apiome.projects p
             JOIN apiome.tenant_administrators ta ON ta.tenant_id = p.tenant_id
             WHERE p.id = v.project_id
               AND ta.user_id = $2
           )
         )`,
      [versionRecordId, userId, visibilityValue]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Only the version owner or a tenant administrator can publish this version' });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function unpublishVersion(versionRecordId: string, userId: string) {
  try {
    const dataCheck = await connectionPool.query(
      `SELECT 1
       FROM apiome.data_record dr
       JOIN apiome.class_schema cs ON dr.class_schema_id = cs.id
       WHERE cs.version_id = $1
       LIMIT 1`,
      [versionRecordId]
    );
    if (dataCheck.rowCount && dataCheck.rowCount > 0) {
      return JSON.stringify({
        success: false,
        error: 'This version has data records and cannot be unpublished. Create a new version or a new minor version to make changes.',
        code: 'VERSION_HAS_DATA',
      });
    }

    const result = await connectionPool.query(
      `UPDATE apiome.versions v
       SET published = false, published_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE v.id = $1
         AND v.deleted_at IS NULL
         AND (
           v.creator_id = $2
           OR EXISTS (
             SELECT 1
             FROM apiome.projects p
             JOIN apiome.tenant_administrators ta ON ta.tenant_id = p.tenant_id
             WHERE p.id = v.project_id
               AND ta.user_id = $2
           )
         )`,
      [versionRecordId, userId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Only the version owner or a tenant administrator can unpublish this version' });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function getPublishedVersionsForTenant(tenantId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT 
        v.id,
        v.version_id,
        v.description,
        v.visibility,
        v.published_at,
        v.created_at,
        v.mock_enabled,
        p.id as project_id,
        p.name as project_name,
        p.slug as project_slug,
        t.id as tenant_id,
        t.name as tenant_name,
        t.slug as tenant_slug,
        u.name as creator_name,
        u.email as creator_email
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       JOIN apiome.tenants t ON p.tenant_id = t.id
       LEFT JOIN apiome.users u ON v.creator_id = u.id
       WHERE p.tenant_id = $1 
         AND v.published = true 
         AND v.deleted_at IS NULL
         AND p.deleted_at IS NULL
         AND t.deleted_at IS NULL
       ORDER BY v.published_at DESC, v.created_at DESC`,
      [tenantId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching published versions:', error);
    return JSON.stringify([]);
  }
}

export async function updateVersionVisibility(versionRecordId: string, visibility: 'public' | 'private') {
  try {
    await connectionPool.query(
      `UPDATE apiome.versions 
       SET visibility = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND deleted_at IS NULL AND published = true`,
      [visibility, versionRecordId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

async function insertVersionProtectionAudit(input: {
  tenantId: string;
  projectId: string | null;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: 'denied' | 'allowed' | 'policy_change';
  detail?: Record<string, unknown> | null;
}) {
  try {
    await connectionPool.query(
      `INSERT INTO apiome.version_protection_audit
        (tenant_id, project_id, actor_id, action, resource_type, resource_id, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.tenantId,
        input.projectId,
        input.actorId,
        input.action,
        input.resourceType,
        input.resourceId,
        input.outcome,
        input.detail ? JSON.stringify(input.detail) : null,
      ]
    );
  } catch (e) {
    console.error('insertVersionProtectionAudit:', e);
  }
}

export async function deleteVersion(versionRecordId: string) {
  try {
    const session = await getAuthSession();
    const userId = (session?.user as { user_id?: string })?.user_id;
    const tenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;
    const isTenantAdmin = Boolean((session?.user as { is_tenant_admin?: boolean })?.is_tenant_admin);
    if (!userId || !tenantId) {
      return JSON.stringify({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    const row = await connectionPool.query(
      `SELECT v.id, v.creator_id, v.revision_locked, v.project_id
       FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       WHERE v.id = $1 AND v.deleted_at IS NULL AND p.tenant_id = $2 AND p.deleted_at IS NULL`,
      [versionRecordId, tenantId]
    );
    if (row.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Version not found' });
    }
    const v = row.rows[0] as {
      id: string;
      creator_id: string | null;
      revision_locked: boolean;
      project_id: string;
    };

    const mayManage = v.creator_id === userId || isTenantAdmin;
    if (!mayManage) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId: v.project_id,
        actorId: userId,
        action: 'version.delete',
        resourceType: 'version',
        resourceId: versionRecordId,
        outcome: 'denied',
        detail: { reason: 'not_owner_or_admin' },
      });
      return JSON.stringify({
        success: false,
        error: 'Only the version creator or a tenant admin can delete this version',
        code: 'FORBIDDEN',
      });
    }

    if (v.revision_locked && !isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId: v.project_id,
        actorId: userId,
        action: 'version.delete',
        resourceType: 'version',
        resourceId: versionRecordId,
        outcome: 'denied',
        detail: { reason: 'revision_locked' },
      });
      return JSON.stringify({
        success: false,
        error: 'This revision is locked by policy and cannot be deleted',
        code: 'REVISION_LOCKED',
      });
    }

    const upd = await connectionPool.query(
      `UPDATE apiome.versions
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL`,
      [versionRecordId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      return JSON.stringify({ success: false, error: 'Version not found or already deleted', code: 'NOT_FOUND' });
    }

    if (v.revision_locked && isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId: v.project_id,
        actorId: userId,
        action: 'version.delete',
        resourceType: 'version',
        resourceId: versionRecordId,
        outcome: 'allowed',
        detail: { reason: 'admin_override_locked_revision' },
      });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

// Property Management Functions
// NOTE: Property CRUD operations have been moved to REST API endpoints.
// Use /api/properties/[projectId] for GET and POST operations.
// Use /api/properties/[projectId]/[propertyId] for GET, PUT, and DELETE operations.

// Class Management Functions

/**
 * Bulk load all classes with their properties and tags for a version.
 * This is much more efficient than loading properties/tags one class at a time.
 * Uses 3 queries instead of 2N+1 queries (where N is number of classes).
 */
export async function getClassesWithPropertiesAndTags(versionId: string) {
  try {
    // Query 1: Get all classes for the version
    const classesResult = await connectionPool.query(
      `SELECT id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at
       FROM apiome.classes
       WHERE version_id = $1 AND deleted_at IS NULL
       ORDER BY name ASC`,
      [versionId]
    );

    const classes = classesResult.rows;

    if (classes.length === 0) {
      return JSON.stringify([]);
    }

    const classIds = classes.map((c: any) => c.id);

    // Query 2: Get all properties for all classes in one query
    // Include p.data as property_source_data to get the original type/constraint definitions
    const propertiesResult = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
              p.id as property_source_id, p.name as property_source_name, p.data as property_source_data
       FROM apiome.class_properties cp
       LEFT JOIN apiome.properties p ON cp.property_id = p.id
       WHERE cp.class_id = ANY($1)
       ORDER BY cp.class_id, cp.parent_id NULLS FIRST, cp.name ASC`,
      [classIds]
    );

    // Query 3: Get all tags for all classes in one query
    const tagsResult = await connectionPool.query(
      `SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
              t.name as tag_name, t.color as tag_color, t.description as tag_description,
              t.project_id
       FROM apiome.class_tags ct
       JOIN apiome.tags t ON ct.tag_id = t.id
       WHERE ct.class_id = ANY($1)
       ORDER BY ct.class_id, t.name ASC`,
      [classIds]
    );

    // Group properties by class_id
    const propertiesByClass = new Map<string, any[]>();
    for (const prop of propertiesResult.rows) {
      const classId = prop.class_id;
      if (!propertiesByClass.has(classId)) {
        propertiesByClass.set(classId, []);
      }
      propertiesByClass.get(classId)!.push(prop);
    }

    // Group tags by class_id
    const tagsByClass = new Map<string, any[]>();
    for (const tag of tagsResult.rows) {
      const classId = tag.class_id;
      if (!tagsByClass.has(classId)) {
        tagsByClass.set(classId, []);
      }
      tagsByClass.get(classId)!.push(tag);
    }

    // Combine classes with their properties and tags
    const classesWithData = classes.map((cls: any) => ({
      ...cls,
      properties: propertiesByClass.get(cls.id) || [],
      tags: tagsByClass.get(cls.id) || []
    }));

    return JSON.stringify(classesWithData);
  } catch (error: any) {
    console.error('Error bulk loading classes with properties and tags:', error);
    return JSON.stringify([]);
  }
}

/**
 * Fetch a single class by ID with its properties and tags.
 * This is more efficient than fetching all classes when only one class needs to be updated.
 */
export async function getClassWithPropertiesAndTags(classId: string) {
  try {
    // Query 1: Get the class
    const classResult = await connectionPool.query(
      `SELECT id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at
       FROM apiome.classes
       WHERE id = $1 AND deleted_at IS NULL`,
      [classId]
    );

    if (classResult.rows.length === 0) {
      return JSON.stringify(null);
    }

    const cls = classResult.rows[0];

    // Query 2: Get all properties for this class
    // Include p.data as property_source_data to get the original type/constraint definitions
    const propertiesResult = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
              p.id as property_source_id, p.name as property_source_name, p.data as property_source_data
       FROM apiome.class_properties cp
       LEFT JOIN apiome.properties p ON cp.property_id = p.id
       WHERE cp.class_id = $1
       ORDER BY cp.parent_id NULLS FIRST, cp.name ASC`,
      [classId]
    );

    // Query 3: Get all tags for this class
    const tagsResult = await connectionPool.query(
      `SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
              t.name as tag_name, t.color as tag_color, t.description as tag_description,
              t.project_id
       FROM apiome.class_tags ct
       JOIN apiome.tags t ON ct.tag_id = t.id
       WHERE ct.class_id = $1
       ORDER BY t.name ASC`,
      [classId]
    );

    // Combine class with its properties and tags
    const classWithData = {
      ...cls,
      properties: propertiesResult.rows,
      tags: tagsResult.rows
    };

    return JSON.stringify(classWithData);
  } catch (error: any) {
    console.error('Error loading class with properties and tags:', error);
    return JSON.stringify(null);
  }
}

export async function getClassesForVersion(versionId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at
       FROM apiome.classes
       WHERE version_id = $1 AND deleted_at IS NULL
       ORDER BY name ASC`,
      [versionId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching classes:', error);
    return JSON.stringify([]);
  }
}

/** Class IDs for a version (canvas import: restrict layout JSON to classes that exist here). */
export async function getClassIdsForVersion(versionId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id FROM apiome.classes WHERE version_id = $1 AND deleted_at IS NULL`,
      [versionId]
    );
    return successResponse({ classIds: result.rows.map((r: { id: string }) => r.id) });
  } catch (error: any) {
    console.error('Error fetching class ids for version:', error);
    return errorResponse(error.message);
  }
}

export async function createClass(versionId: string, name: string, description: string | null, schema: any) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Class name is required' });
    }

    if (!schema) {
      return JSON.stringify({ success: false, error: 'Class schema is required' });
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.classes (version_id, name, description, schema)
       VALUES ($1, $2, $3, $4)
       RETURNING id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at`,
      [versionId, name.trim(), description, JSON.stringify(schema)]
    );

    return JSON.stringify({ success: true, class: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating class:', error);

    // Handle unique constraint violation (duplicate name in same version)
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A class with this name already exists in this version' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateClass(classId: string, name: string, description: string | null, schema: any) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Class name is required' });
    }

    if (!schema) {
      return JSON.stringify({ success: false, error: 'Class schema is required' });
    }

    // Get the old class name before updating
    const oldClassResult = await connectionPool.query(
      `SELECT name, version_id FROM apiome.classes WHERE id = $1 AND deleted_at IS NULL`,
      [classId]
    );

    if (oldClassResult.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Class not found' });
    }

    const oldClassName = oldClassResult.rows[0].name;
    const versionId = oldClassResult.rows[0].version_id;
    const newClassName = name.trim();

    // Update the class
    const result = await connectionPool.query(
      `UPDATE apiome.classes
       SET name = $1, description = $2, schema = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 AND deleted_at IS NULL
       RETURNING id, version_id, name, description, schema, enabled, canvas_metadata, created_at, updated_at`,
      [newClassName, description, JSON.stringify(schema), classId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Class not found' });
    }

    // If the class name changed, update all $ref values that reference it
    if (oldClassName !== newClassName) {
      const oldRefPath = `#/components/schemas/${oldClassName}`;
      const newRefPath = `#/components/schemas/${newClassName}`;

      // Get all classes in the same version
      const classesInVersion = await connectionPool.query(
        `SELECT id FROM apiome.classes WHERE version_id = $1 AND deleted_at IS NULL`,
        [versionId]
      );

      const classIds = classesInVersion.rows.map((row: any) => row.id);

      if (classIds.length > 0) {
        // Get all class properties for these classes
        const propertiesResult = await connectionPool.query(
          `SELECT id, data FROM apiome.class_properties WHERE class_id = ANY($1)`,
          [classIds]
        );

        // Update each property that references the old class name
        for (const prop of propertiesResult.rows) {
          const propData = typeof prop.data === 'string' ? JSON.parse(prop.data) : prop.data;
          let updated = false;

          // Check direct $ref
          if (propData.$ref === oldRefPath) {
            propData.$ref = newRefPath;
            updated = true;
          }

          // Check array items $ref
          if (propData.type === 'array' && propData.items?.$ref === oldRefPath) {
            propData.items.$ref = newRefPath;
            updated = true;
          }

          // Update the property if it was changed
          if (updated) {
            await connectionPool.query(
              `UPDATE apiome.class_properties SET data = $1 WHERE id = $2`,
              [JSON.stringify(propData), prop.id]
            );
          }
        }
      }
    }

    return JSON.stringify({ success: true, class: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating class:', error);

    // Handle unique constraint violation
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A class with this name already exists in this version' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function deleteClass(classId: string) {
  try {
    // Soft delete - set deleted_at timestamp
    const result = await connectionPool.query(
      `UPDATE apiome.classes
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [classId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Class not found' });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error deleting class:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Update canvas metadata for a class (position, dimensions, styling).
 * This is UI-only data and does not affect the class schema for code generation or exports.
 *
 * @param classId - The ID of the class to update
 * @param canvasMetadata - Canvas metadata object containing position, dimensions, and style
 * @returns JSON response with success status
 */
export async function updateClassCanvasMetadata(classId: string, canvasMetadata: {
  position?: { x: number; y: number };
  dimensions?: { width?: number; height?: number };
  style?: {
    backgroundColor?: string;
    borderColor?: string;
    headerGradient?: string;
    textColor?: string;
    headerTextColor?: string;
    icon?: string; // Custom icon from lucide-react
    collapsed?: boolean;
    zIndex?: number;
  };
  group?: string | null;
} | null) {
  try {
    const result = await connectionPool.query(
      `UPDATE apiome.classes
       SET canvas_metadata = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, canvas_metadata`,
      [canvasMetadata ? JSON.stringify(canvasMetadata) : null, classId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Class not found' });
    }

    return JSON.stringify({ success: true, canvas_metadata: result.rows[0].canvas_metadata });
  } catch (error: any) {
    console.error('Error updating class canvas metadata:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Batch update canvas metadata for multiple classes.
 * Useful for saving entire canvas layouts at once.
 *
 * @param updates - Array of { classId, canvasMetadata } objects
 * @returns JSON response with success status and count of updated classes
 */
export async function batchUpdateClassCanvasMetadata(updates: Array<{
  classId: string;
  canvasMetadata: {
    position?: { x: number; y: number };
    dimensions?: { width?: number; height?: number };
    style?: {
      backgroundColor?: string;
      borderColor?: string;
      headerGradient?: string;
      textColor?: string;
      headerTextColor?: string;
      collapsed?: boolean;
      zIndex?: number;
    };
    group?: string | null;
  } | null;
}>) {
  try {
    if (!updates || updates.length === 0) {
      return JSON.stringify({ success: true, updatedCount: 0 });
    }

    let updatedCount = 0;

    // Use a transaction for batch updates
    await connectionPool.query('BEGIN');

    for (const update of updates) {
      const result = await connectionPool.query(
        `UPDATE apiome.classes
         SET canvas_metadata = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND deleted_at IS NULL`,
        [update.canvasMetadata ? JSON.stringify(update.canvasMetadata) : null, update.classId]
      );
      updatedCount += result.rowCount;
    }

    await connectionPool.query('COMMIT');

    return JSON.stringify({ success: true, updatedCount });
  } catch (error: any) {
    await connectionPool.query('ROLLBACK');
    console.error('Error batch updating class canvas metadata:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function extractObjectPropertyToClass(
  classPropertyId: string,
  newClassName: string,
  newClassDescription: string | null
) {
  try {
    if (!newClassName || newClassName.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'New class name is required' });
    }

    // Get the class property to extract
    const propertyResult = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.name, cp.description, cp.data, cp.parent_id,
              c.version_id
       FROM apiome.class_properties cp
       JOIN apiome.classes c ON cp.class_id = c.id
       WHERE cp.id = $1`,
      [classPropertyId]
    );

    if (propertyResult.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Property not found' });
    }

    const classProperty = propertyResult.rows[0];
    const rawData = classProperty?.data;
    const propData = rawData == null
      ? {}
      : (typeof rawData === 'string' ? (() => { try { return JSON.parse(rawData); } catch { return {}; } })() : rawData);

    // Validate that it's an object type
    const propType = (propData as any)?.type;
    const isDirectObject = propType === 'object' && !(propData as any)?.$ref;
    const isArrayOfObjects = propType === 'array' && (propData as any)?.items?.type === 'object' && !(propData as any)?.items?.$ref;

    if (!isDirectObject && !isArrayOfObjects) {
      return JSON.stringify({
        success: false,
        error: 'Only object properties or arrays of objects can be extracted to a class'
      });
    }

    // Check if class name already exists in this version
    const existingClassCheck = await connectionPool.query(
      `SELECT id FROM apiome.classes 
       WHERE version_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [classProperty.version_id, newClassName.trim()]
    );

    if (existingClassCheck.rowCount > 0) {
      return JSON.stringify({
        success: false,
        error: `A class named "${newClassName}" already exists in this version`
      });
    }

    // Get nested properties if any exist
    const nestedPropsResult = await connectionPool.query(
      `SELECT id, property_id, name, description, data
       FROM apiome.class_properties
       WHERE parent_id = $1
       ORDER BY name ASC`,
      [classPropertyId]
    );

    // Extract the object schema
    const objectSchema = isArrayOfObjects ? propData.items : propData;

    // Create the new class with the object schema
    const newClassResult = await connectionPool.query(
      `INSERT INTO apiome.classes (version_id, name, description, schema)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name`,
      [
        classProperty.version_id,
        newClassName.trim(),
        newClassDescription || `Extracted from ${classProperty.name}`,
        JSON.stringify(objectSchema)
      ]
    );

    const newClass = newClassResult.rows[0];

    // Get ALL nested properties recursively using a CTE that tracks depth
    // We need to fetch the entire hierarchy and process level by level to maintain parent-child relationships
    const allNestedPropsResult = await connectionPool.query(
      `WITH RECURSIVE nested_props AS (
        -- Base case: direct children of the extracted property (depth 1)
        SELECT id, property_id, name, description, data, parent_id, 1 as depth
        FROM apiome.class_properties
        WHERE parent_id = $1
        
        UNION ALL
        
        -- Recursive case: children of children (depth + 1)
        SELECT cp.id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id, np.depth + 1
        FROM apiome.class_properties cp
        INNER JOIN nested_props np ON cp.parent_id = np.id
      )
      SELECT * FROM nested_props
      ORDER BY depth ASC, name ASC`,
      [classPropertyId]
    );

    // Map old property IDs to new property IDs to maintain parent-child relationships
    const oldToNewIdMap = new Map<string, string | null>();
    oldToNewIdMap.set(classPropertyId, null); // The extracted property becomes the root (NULL parent)

    // Copy all nested properties level by level (parents before children)
    // Due to constraint 'class_properties_null_property_id_is_reference', we can only copy properties that:
    // 1. Have property_id !== NULL (from property library), OR
    // 2. Are references (have $ref in data)
    for (const nestedProp of allNestedPropsResult.rows) {
      const rawNested = nestedProp?.data;
      const nestedData = rawNested == null
        ? {}
        : (typeof rawNested === 'string' ? (() => { try { return JSON.parse(rawNested); } catch { return {}; } })() : rawNested);

      // Check if this property satisfies the database constraint
      const hasPropertyId = nestedProp.property_id !== null;
      const isReference = (nestedData as any)?.$ref || ((nestedData as any)?.type === 'array' && (nestedData as any)?.items?.$ref);
      const canBeCopied = hasPropertyId || isReference;

      if (!canBeCopied) {
        console.warn(`Skipping inline property "${nestedProp.name}" at depth ${nestedProp.depth} - not from library and not a reference`);
        continue;
      }

      // Determine the new parent_id by looking up the old parent_id in our map
      const oldParentId = nestedProp.parent_id;
      const newParentId = oldToNewIdMap.get(oldParentId) !== undefined
        ? oldToNewIdMap.get(oldParentId)
        : null;

      // Insert the property into the new class
      const insertResult = await connectionPool.query(
        `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          newClass.id,
          nestedProp.property_id, // Preserve property_id (NULL for references, ID for library properties)
          nestedProp.name,
          nestedProp.description,
          nestedProp.data,
          newParentId
        ]
      );

      // Store the mapping of old ID to new ID for this property
      oldToNewIdMap.set(nestedProp.id, insertResult.rows[0].id);
    }

    // Update the original property to reference the new class
    const updatedPropData: any = { ...(propData as any) };
    if (isArrayOfObjects) {
      updatedPropData.items = {
        $ref: `#/components/schemas/${newClassName.trim()}`
      };
    } else {
      updatedPropData.$ref = `#/components/schemas/${newClassName.trim()}`;
      delete updatedPropData.type;
      delete updatedPropData.properties;
      delete updatedPropData.additionalProperties;
    }

    await connectionPool.query(
      `UPDATE apiome.class_properties
       SET data = $1
       WHERE id = $2`,
      [JSON.stringify(updatedPropData), classPropertyId]
    );

    // Delete the nested properties from the original location
    await connectionPool.query(
      `DELETE FROM apiome.class_properties
       WHERE parent_id = $1`,
      [classPropertyId]
    );

    return JSON.stringify({
      success: true,
      newClassId: newClass.id,
      newClassName: newClass.name,
      message: `Successfully extracted "${classProperty.name}" to new class "${newClass.name}"`
    });
  } catch (error: any) {
    console.error('Error extracting property to class:', error);
    if (error.code === '23505') {
      return JSON.stringify({
        success: false,
        error: 'A class with this name already exists in this version'
      });
    }
    return JSON.stringify({ success: false, error: error.message });
  }
}

// Class-Property Relationship Management Functions

export async function getPropertiesForClass(classId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
              p.id as property_source_id, p.name as property_source_name
       FROM apiome.class_properties cp
       LEFT JOIN apiome.properties p ON cp.property_id = p.id
       WHERE cp.class_id = $1
       ORDER BY cp.parent_id NULLS FIRST, cp.name ASC`,
      [classId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching class properties:', error);
    return JSON.stringify([]);
  }
}

/**
 * Fetch class_properties for many classes in one query (Studio sidebar $ref warnings).
 * Returns JSON: `Record<classId, rows[]>` with the same row shape as {@link getPropertiesForClass}.
 */
export async function getPropertiesForClassesBatch(classIds: string[]) {
  try {
    const unique = [...new Set(classIds.filter(Boolean))];
    if (unique.length === 0) {
      return JSON.stringify({});
    }
    const result = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.property_id, cp.name, cp.description, cp.data, cp.parent_id,
              p.id as property_source_id, p.name as property_source_name
       FROM apiome.class_properties cp
       LEFT JOIN apiome.properties p ON cp.property_id = p.id
       WHERE cp.class_id = ANY($1::uuid[])
       ORDER BY cp.class_id, cp.parent_id NULLS FIRST, cp.name ASC`,
      [unique]
    );

    const byClass: Record<string, unknown[]> = {};
    for (const row of result.rows) {
      const cid = String((row as { class_id: string }).class_id);
      if (!byClass[cid]) byClass[cid] = [];
      byClass[cid].push(row);
    }
    return JSON.stringify(byClass);
  } catch (error: any) {
    console.error('Error batch-fetching class properties:', error);
    return JSON.stringify({});
  }
}

export async function addPropertyToClass(classId: string, propertyId: string | null, name: string, description: string | null, data: any, parentId: string | null = null) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Property name is required' });
    }

    if (!data) {
      return JSON.stringify({ success: false, error: 'Property data is required' });
    }

    // Check if property already exists in this class with the same parent
    const existingCheck = await connectionPool.query(
      'SELECT id FROM apiome.class_properties WHERE class_id = $1 AND name = $2 AND (parent_id = $3 OR (parent_id IS NULL AND $3 IS NULL))',
      [classId, name, parentId]
    );

    if (existingCheck.rowCount > 0) {
      return JSON.stringify({ success: false, error: 'A property with this name already exists at this level' });
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, class_id, property_id, name, description, data, parent_id`,
      [classId, propertyId, name.trim(), description, JSON.stringify(data), parentId]
    );

    return JSON.stringify({ success: true, classProperty: result.rows[0] });
  } catch (error: any) {
    console.error('Error adding property to class:', error);

    // Handle unique constraint violation
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A property with this name already exists at this level' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Delete all class_properties for a class (#587 overwrite existing).
 * Used when replacing an existing class with an imported schema.
 */
export async function deleteClassPropertiesForClass(classId: string) {
  await connectionPool.query(
    `DELETE FROM apiome.class_properties WHERE class_id = $1`,
    [classId]
  );
}

// Class Property Management Functions
// NOTE: Class property CRUD operations have been moved to REST API endpoints.
// Use /api/classes/[classId]/properties for POST operations (add property).
// Use /api/classes/[classId]/properties/[classPropertyId] for PUT (update) and DELETE (delete) operations.

// OpenAPI Import Functions

/** Options for OpenAPI import: paths, securitySchemes, servers (#425) */
export interface OpenAPIImportOptions {
  paths?: Array<{
    path: string;
    summary?: string;
    description?: string;
    parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: Record<string, unknown> }>;
    operations: Array<{
      method: string;
      operationId?: string;
      summary?: string;
      description?: string;
      tags?: string[];
      deprecated?: boolean;
      parameters: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: Record<string, unknown> }>;
      requestBody?: { required?: boolean; description?: string; content: Record<string, { schema?: Record<string, unknown>; $ref?: string }> };
      responses: Record<string, { description?: string; content?: Record<string, { schema?: Record<string, unknown>; $ref?: string }>; headers?: Record<string, unknown>; links?: Record<string, unknown> }>;
      security?: Record<string, string[]>;
    }>;
  }>;
  securitySchemes?: Array<{
    scheme_name: string;
    scheme_type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
    in_location?: 'header' | 'query' | 'cookie';
    param_name?: string;
    http_scheme?: string;
    description?: string;
    data?: Record<string, unknown>;
  }>;
  servers?: Array<{ url: string; description?: string; variables?: Record<string, { default: string; enum?: string[]; description?: string }> }>;
}

export async function importProjectFromOpenAPI(
  tenantId: string,
  creatorId: string,
  projectName: string,
  projectSlug: string,
  projectDescription: string | null,
  versionId: string,
  versionDescription: string | null,
  classes: any[],
  options?: OpenAPIImportOptions
) {
  const client = await connectionPool.connect();

  // Helper: deep sort object keys for stable equality checks
  const sortKeysDeep = (value: any): any => {
    if (Array.isArray(value)) {
      return value.map(sortKeysDeep);
    }
    if (value && typeof value === 'object') {
      const sorted: any = {};
      Object.keys(value).sort().forEach((k) => {
        const v = (value as any)[k];
        if (v !== undefined) {
          sorted[k] = sortKeysDeep(v);
        }
      });
      return sorted;
    }
    return value;
  };

  // Helper: stable stringify for equality comparison
  const stableStringify = (obj: any) => JSON.stringify(sortKeysDeep(obj));

  // Helper: remove class-specific flags from root property data (e.g., required)
  const sanitizeRootPropertyData = (data: any): any => {
    if (!data || typeof data !== 'object') return data;
    const clone = JSON.parse(JSON.stringify(data));
    if (typeof clone.required === 'boolean') delete clone.required; // class-level concern only
    return clone;
  };

  const extractRefName = (ref: string | undefined): string | null => {
    if (!ref) return null;
    const parts = ref.split('/');
    return parts[parts.length - 1] || null;
  };

  // Produce a compact alphanumeric type code
  const typeCodeFor = (data: any): string => {
    if (!data || typeof data !== 'object') return 'X';
    if (data.$ref) {
      const refName = extractRefName(data.$ref) || 'Ref';
      return 'R' + refName.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    }
    const t = data.type;
    if (t === 'array') {
      const items = data.items || {};
      if (items.$ref) {
        const refName = extractRefName(items.$ref) || 'Ref';
        return 'A' + refName.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
      }
      if (items.type) {
        return 'A' + String(items.type).replace(/[^A-Za-z0-9]/g, '').slice(0, 20).toUpperCase();
      }
      return 'A';
    }
    if (t) {
      const map: Record<string,string> = {
        string: 'S', integer: 'I', number: 'N', boolean: 'B', object: 'O'
      };
      return map[t] || String(t).replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() || 'X';
    }
    if (data.oneOf) return 'ONEOF';
    if (data.anyOf) return 'ANYOF';
    if (data.allOf) return 'ALLOF';
    return 'SCHEMA';
  };

  const shortHash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8).toUpperCase();
  const sanitizeBase = (name: string): string => {
    const cleaned = name.replace(/[^A-Za-z0-9]/g, '');
    return cleaned.length > 0 ? cleaned : 'Property';
  };

  try {
    await client.query('BEGIN');

    // 1. Create project
    const projectResult = await client.query(
      `INSERT INTO apiome.projects (tenant_id, creator_id, name, description, slug)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, creatorId, projectName.trim(), projectDescription?.trim() || null, projectSlug.trim().toLowerCase()]
    );
    const project = projectResult.rows[0];

    // 2. Create version
    const versionResult = await client.query(
      `INSERT INTO apiome.versions (project_id, creator_id, version_id, description)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [project.id, creatorId, versionId.trim(), versionDescription?.trim() || null]
    );
    const version = versionResult.rows[0];

    // 2b. Import servers (OpenAPI 3.1 servers array) - #425
    if (options?.servers?.length) {
      for (let i = 0; i < options.servers.length; i++) {
        const s = options.servers[i];
        if (!s?.url) continue;
        const variablesJson = s.variables && Object.keys(s.variables).length > 0 ? JSON.stringify(s.variables) : null;
        await client.query(
          `INSERT INTO apiome.version_server (version_id, name, url, description, sort_order, variables)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [version.id, null, s.url.trim(), s.description?.trim() || null, i, variablesJson || '{}']
        );
      }
    }

    // 3. Flatten properties (include nested)
    type PropertyInfo = { name: string; data: any; description?: string; _className?: string };
    const allPropsFlat: PropertyInfo[] = [];
    const collectAll = (props: any[], className: string) => {
      for (const p of props || []) {
        allPropsFlat.push({ name: p.name, data: p.data, description: p.description, _className: className });
        if (p.children && p.children.length) collectAll(p.children, className);
      }
    };
    for (const cls of classes) collectAll(cls.properties || [], cls.name);

    // Helper: check if property data is a reference ($ref at root or items.$ref for arrays)
    const isReference = (data: any): boolean => {
      if (!data || typeof data !== 'object') return false;
      if (data.$ref) return true;
      if (data.type === 'array' && data.items?.$ref) return true;
      return false;
    };

    // Group signatures per original base name (exclude references - they won't go into property library)
    interface SigRecord { canonical: any; sig: string; typeCode: string; original: PropertyInfo; }
    const baseToSigRecords = new Map<string, SigRecord[]>();

    for (const p of allPropsFlat) {
      // Skip references - they will be created directly as class properties
      if (isReference(p.data)) continue;

      const canonical = sanitizeRootPropertyData(p.data);
      const sig = stableStringify(canonical);
      const typeCode = typeCodeFor(canonical);
      const arr = baseToSigRecords.get(p.name) || [];
      // Avoid storing duplicate identical signature records (same schema reused across classes)
      if (!arr.some(r => r.sig === sig)) {
        arr.push({ canonical, sig, typeCode, original: p });
      }
      baseToSigRecords.set(p.name, arr);
    }

    // 4. Decide project-level property names (alphanumeric only)
    const projectNameToData = new Map<string, { canonical: any; description?: string }>();
    const signatureToProjectName = new Map<string, string>(); // sig -> project name

    for (const [baseName, records] of baseToSigRecords.entries()) {
      const multi = records.length > 1;
      const baseSanitized = sanitizeBase(baseName); // sanitized base for naming

      for (const rec of records) {
        let projectPropName: string;
        if (!multi) {
          // Single signature group: prefer base sanitized
            projectPropName = baseSanitized;
            // Collision fallback: if name already taken by different signature, decorate
            if (projectNameToData.has(projectPropName)) {
              const existingSig = Array.from(signatureToProjectName.entries()).find(([s,n]) => n === projectPropName)?.[0];
              if (existingSig && existingSig !== rec.sig) {
                projectPropName = `${baseSanitized}${rec.typeCode}${shortHash(rec.sig)}`.slice(0,255);
              }
            }
        } else {
          // Multiple distinct signatures: decorate with type code + hash
          projectPropName = `${baseSanitized}${rec.typeCode}${shortHash(rec.sig)}`;
          if (projectPropName.length > 255) projectPropName = projectPropName.slice(0,255);
        }

        // Ensure only alphanumeric (sanitization might have left non-alnum from typeCode/hash but both are alnum already)
        projectPropName = projectPropName.replace(/[^A-Za-z0-9]/g, '');

        if (!projectNameToData.has(projectPropName)) {
          projectNameToData.set(projectPropName, { canonical: rec.canonical, description: rec.original.description });
          signatureToProjectName.set(rec.sig, projectPropName);
        } else {
          // If identical signature but different candidate name (rare), reuse existing mapping
          const existingName = signatureToProjectName.get(rec.sig);
          if (!existingName) signatureToProjectName.set(rec.sig, projectPropName);
        }
      }
    }

    // 5. Insert project-level properties (reuse by computed alphanumeric name)
    const propertyIdByProjectName = new Map<string, string>();
    for (const [propName, payload] of projectNameToData.entries()) {
      const insertRes = await client.query(
        `INSERT INTO apiome.properties (project_id, name, description, data)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [project.id, propName, payload.description?.trim() || null, JSON.stringify(payload.canonical)]
      );
      propertyIdByProjectName.set(propName, insertRes.rows[0].id);
    }

    // 6. Create classes and link properties (preserve original class property names)
    const linkProperties = async (classId: string, props: any[], parentId: string | null = null) => {
      for (const p of props || []) {
        let propertyId: string | null = null;

        // Check if this is a reference property
        if (isReference(p.data)) {
          // References are created directly as class properties without a property_id
          // They are class-specific relationships, not reusable properties
          propertyId = null;
        } else {
          // Non-reference properties use the property library
          const canonical = sanitizeRootPropertyData(p.data);
          const sig = stableStringify(canonical);
          const projectName = signatureToProjectName.get(sig);
          if (!projectName) continue; // safety
          const pid = propertyIdByProjectName.get(projectName);
          if (!pid) continue;
          propertyId = pid;
        }

        const classPropRes = await client.query(
          `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [classId, propertyId, p.name.trim(), p.description?.trim() || null, JSON.stringify(p.data), parentId]
        );

        if (p.children && p.children.length) {
          await linkProperties(classId, p.children, classPropRes.rows[0].id);
        }
      }
    };

    for (const cls of classes) {
      // Use the schema from the class if available, otherwise default to { type: 'object' }
      const schema = cls.schema || { type: 'object' };
      const classRes = await client.query(
        `INSERT INTO apiome.classes (version_id, name, description, schema)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [version.id, cls.name.trim(), cls.description?.trim() || null, JSON.stringify(schema)]
      );
      await linkProperties(classRes.rows[0].id, cls.properties || [], null);
    }

    await client.query('COMMIT');

    // Import paths and security schemes (OpenAPI 3.1 pathing + components.securitySchemes) - #425
    if (options?.paths?.length || options?.securitySchemes?.length) {
      const { importOpenAPIPathsAndSecurity } = await import('./import-openapi-paths-security');
      const pathResult = await importOpenAPIPathsAndSecurity(
        version.id,
        options.paths ?? [],
        options.securitySchemes ?? []
      );
      if (!pathResult.success) {
        return JSON.stringify({ success: false, error: pathResult.error || 'Failed to import paths or security schemes' });
      }
    }

    return JSON.stringify({ success: true, projectId: project.id, versionId: version.id });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}

    if (error && error.code === '23505') {
      const msg = (error.detail || error.message || '').toLowerCase();
      if (msg.includes('projects') && msg.includes('slug')) {
        return JSON.stringify({ success: false, error: 'A project with this slug already exists in this tenant' });
      }
      if (msg.includes('versions') && msg.includes('version_id')) {
        return JSON.stringify({ success: false, error: 'A version with this ID already exists for this project' });
      }
      if (msg.includes('properties') && msg.includes('project_id') && msg.includes('name')) {
        return JSON.stringify({ success: false, error: 'A property with this name already exists in this project' });
      }
    }

    return JSON.stringify({ success: false, error: error?.message || 'Failed to import project from OpenAPI' });
  } finally {
    client.release();
  }
}

export async function getApiKeysForTenant(tenantId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT * FROM apiome.api_keys 
       WHERE tenant_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [tenantId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    return JSON.stringify([]);
  }
}

export async function createApiKey(
  tenantId: string,
  name: string,
  description: string,
  expiresInDays: number | null,
  scopes: string[] | null = null,
) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'API key name is required' });
    }

    let normalizedScopes: string[];
    try {
      normalizedScopes = normalizeApiKeyScopes(scopes);
    } catch (scopeErr: any) {
      return JSON.stringify({ success: false, error: scopeErr?.message || 'Invalid scopes' });
    }

    const session = await getAuthSession();
    const sessionUser = session?.user as { id?: string } | undefined;
    const createdByUserId =
      typeof sessionUser?.id === 'string' && sessionUser.id.trim() !== '' ? sessionUser.id.trim() : null;

    // Generate a random API key
    const apiKey = 'sk_' + crypto.randomBytes(32).toString('hex');
    const keyPrefix = apiKey.substring(0, 12) + '...';

    // Hash the API key for storage
    const saltRounds = 10;
    const keyHash = await bcrypt.hash(apiKey, saltRounds);

    // Calculate expiration date if provided
    let expiresAt = null;
    if (expiresInDays && expiresInDays > 0) {
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + expiresInDays);
      expiresAt = expirationDate;
    }

    // Insert the API key (created_by_user_id: REST uses this as creator_id for API-key writes)
    const result = await connectionPool.query(
      `INSERT INTO apiome.api_keys (tenant_id, name, description, key_hash, key_prefix, expires_at, created_by_user_id, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, key_prefix, scopes, created_at`,
      [tenantId, name.trim(), description?.trim() || null, keyHash, keyPrefix, expiresAt, createdByUserId, normalizedScopes]
    );

    // Return the plain API key (only time it will be visible)
    return JSON.stringify({
      success: true,
      apiKey: apiKey,
      id: result.rows[0].id,
      keyPrefix: result.rows[0].key_prefix,
      scopes: result.rows[0].scopes,
      createdAt: result.rows[0].created_at
    });
  } catch (error: any) {
    if (error.code === '23505') { // Unique constraint violation
      return JSON.stringify({ success: false, error: 'An API key with this name already exists for this tenant' });
    }
    // Pre-V177 DB without scopes column — retry without scopes (full-access legacy).
    if (error.code === '42703' || String(error.message || '').toLowerCase().includes('scopes')) {
      try {
        const session = await getAuthSession();
        const sessionUser = session?.user as { id?: string } | undefined;
        const createdByUserId =
          typeof sessionUser?.id === 'string' && sessionUser.id.trim() !== '' ? sessionUser.id.trim() : null;
        const apiKey = 'sk_' + crypto.randomBytes(32).toString('hex');
        const keyPrefix = apiKey.substring(0, 12) + '...';
        const keyHash = await bcrypt.hash(apiKey, 10);
        let expiresAt = null;
        if (expiresInDays && expiresInDays > 0) {
          const expirationDate = new Date();
          expirationDate.setDate(expirationDate.getDate() + expiresInDays);
          expiresAt = expirationDate;
        }
        const result = await connectionPool.query(
          `INSERT INTO apiome.api_keys (tenant_id, name, description, key_hash, key_prefix, expires_at, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, key_prefix, created_at`,
          [tenantId, name.trim(), description?.trim() || null, keyHash, keyPrefix, expiresAt, createdByUserId]
        );
        return JSON.stringify({
          success: true,
          apiKey: apiKey,
          id: result.rows[0].id,
          keyPrefix: result.rows[0].key_prefix,
          scopes: ['*'],
          createdAt: result.rows[0].created_at
        });
      } catch (retryErr: any) {
        return JSON.stringify({ success: false, error: retryErr.message });
      }
    }
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function deleteApiKey(apiKeyId: string) {
  try {
    // Soft delete the API key
    await connectionPool.query(
      'UPDATE apiome.api_keys SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1',
      [apiKeyId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function toggleApiKeyStatus(apiKeyId: string, enabled: boolean) {
  try {
    await connectionPool.query(
      'UPDATE apiome.api_keys SET enabled = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [enabled, apiKeyId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateApiKeyLastUsed(apiKeyId: string) {
  try {
    await connectionPool.query(
      'UPDATE apiome.api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [apiKeyId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function validateApiKey(apiKey: string) {
  try {
    // Extract prefix for faster lookup
    const keyPrefix = apiKey.substring(0, 12) + '...';

    // Get all API keys with matching prefix
    const result = await connectionPool.query(
      `SELECT ak.id, ak.tenant_id, ak.key_hash, ak.expires_at, ak.enabled, t.id as tenant_id, t.name as tenant_name
       FROM apiome.api_keys ak
       JOIN apiome.tenants t ON ak.tenant_id = t.id
       WHERE ak.key_prefix = $1 
       AND ak.deleted_at IS NULL 
       AND ak.enabled = true
       AND t.deleted_at IS NULL
       AND t.enabled = true`,
      [keyPrefix]
    );

    // Check each result to find matching hash
    for (const row of result.rows) {
      const isValid = await bcrypt.compare(apiKey, row.key_hash);

      if (isValid) {
        // Check expiration
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          return JSON.stringify({ success: false, error: 'API key has expired' });
        }

        // Update last used timestamp
        await updateApiKeyLastUsed(row.id);

        return JSON.stringify({
          success: true,
          tenantId: row.tenant_id,
          tenantName: row.tenant_name,
          apiKeyId: row.id
        });
      }
    }

    return JSON.stringify({ success: false, error: 'Invalid API key' });
  } catch (error: any) {
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateClassPropertyRef(classPropertyId: string, targetClassId: string) {
  try {
    // Load current class property data and owning class
    const cpRes = await connectionPool.query(
      `SELECT cp.id, cp.class_id, cp.data
       FROM apiome.class_properties cp
       WHERE cp.id = $1`,
      [classPropertyId]
    );
    if (cpRes.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Class property not found' });
    }

    const classId = cpRes.rows[0].class_id;
    const rawData = cpRes.rows[0].data;
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : (rawData || {});

    // Load target class name for $ref construction
    const clsRes = await connectionPool.query(
      `SELECT name FROM apiome.classes WHERE id = $1 AND deleted_at IS NULL`,
      [targetClassId]
    );
    if (clsRes.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Target class not found' });
    }
    const targetClassName = clsRes.rows[0].name;
    const refPath = `#/components/schemas/${targetClassName}`;

    // Update $ref depending on array vs non-array
    if (data && data.type === 'array') {
      const items = data.items && typeof data.items === 'object' ? { ...data.items } : {};
      // Assign items.$ref and remove conflicting items.type
      items.$ref = refPath;
      if (items.type) delete items.type;
      data.items = items;
    } else {
      // Assign direct $ref and remove conflicting type
      data.$ref = refPath;
      if (data.type) delete data.type;
      // If had inline properties for object, keep them as-is; UI may still allow.
    }

    await connectionPool.query(
      `UPDATE apiome.class_properties SET data = $1 WHERE id = $2`,
      [JSON.stringify(data), classPropertyId]
    );

    return JSON.stringify({ success: true, classId });
  } catch (error: any) {
    console.error('Error updating class property $ref:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function createSignupRequest(name: string, email: string, password: string, signupSource: string) {
  try {
    // Check if email already exists in signup table
    const existingSignup = await connectionPool.query(
      'SELECT email_address FROM apiome.signup WHERE email_address = $1',
      [email]
    );

    if (existingSignup.rowCount > 0) {
      return JSON.stringify({
        success: false,
        duplicate: true,
        message: 'You have already requested account access, thank you for your continued interest!'
      });
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Insert the signup request
    await connectionPool.query(
      'INSERT INTO apiome.signup (name, email_address, password, signup_source) VALUES ($1, $2, $3, $4)',
      [name, email, hashedPassword, signupSource]
    );

    return JSON.stringify({
      success: true,
      message: 'Your signup was accepted, and you will be contacted by a member of the Apiome staff shortly.'
    });
  } catch (error: any) {
    console.error('Error creating signup request:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

// External Authentication Provider Functions

/**
 * Bind a linked-account server action to its authenticated caller (OLO-7.3 threat-model fix).
 *
 * `helper.ts` is a `'use server'` module, so every exported async function is a callable server
 * action whose arguments are fully client-controlled. The linked-account / personal-access-token
 * actions historically took `userId` as a plain argument and used it directly in their SQL
 * `WHERE ... user_id = $userId` clauses — which only ever compared the target against the value the
 * *caller* supplied, providing no authorization. That let any authenticated user pass a victim's id
 * to read the victim's linked providers / PAT suffixes or unlink / overwrite / wipe their tokens
 * (a cross-user IDOR).
 *
 * This helper re-derives the acting user from the server-side session and only proceeds when the
 * requested `userId` matches it, so the incoming argument can never widen access beyond the caller.
 *
 * @param userId The user id the caller is asking to act on (from the client bundle — untrusted).
 * @returns The authenticated session user id when it equals `userId`; otherwise `null`
 *   (unauthenticated, or an attempt to act on another user). Callers must treat `null` as "refuse",
 *   returning their own not-found/empty shape so the response does not distinguish the two cases.
 */
async function resolveOwnLinkedAccountUserId(userId: string): Promise<string | null> {
  const session = await getAuthSession();
  const sessionUserId = (session?.user as { user_id?: string } | undefined)?.user_id;
  if (typeof sessionUserId !== 'string' || sessionUserId.trim() === '') {
    return null;
  }
  return sessionUserId === userId ? sessionUserId : null;
}

export async function getLinkedAccountsForUser(userId: string) {
  try {
    const authedUserId = await resolveOwnLinkedAccountUserId(userId);
    if (!authedUserId) {
      // Not signed in, or asking for another user's identities — disclose nothing.
      return JSON.stringify([]);
    }
    const result = await connectionPool.query(
      `SELECT id, provider, provider_user_id, provider_email, email_verified, provider_username,
              (CASE WHEN access_token IS NOT NULL THEN RIGHT(access_token, 6) ELSE NULL END) AS access_token_suffix,
              created_at, last_login_at
       FROM apiome.external_auth_providers
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [authedUserId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching linked accounts:', error);
    return JSON.stringify([]);
  }
}

/**
 * Links an external OAuth identity to a user, enforcing the OLO-1.2 identity invariants.
 *
 * Rejections carry a stable machine-readable `code` (the structured auth error contract,
 * OLO-1.5 — see `apiome-ui/docs/AUTH_ERROR_CODES.md`) alongside the human-readable `error`:
 *   - `provider-already-linked`: this user already has an identity for this provider.
 *   - `identity-linked-elsewhere`: this provider identity is already bound to a *different* user.
 *
 * @param emailVerified Whether the provider proved the address is verified. Stored on the identity
 *   so the account-resolution engine (1.3) can refuse to auto-link on an unverified email.
 */
export async function linkExternalAccount(
  userId: string,
  provider: string,
  providerUserId: string,
  providerEmail: string,
  providerUsername: string | null,
  accessToken: string | null,
  refreshToken: string | null,
  tokenExpiresAt: Date | null,
  profileData: any,
  emailVerified: boolean = false
) {
  try {
    // Check if this provider is already linked to this user
    const existingLink = await connectionPool.query(
      'SELECT id FROM apiome.external_auth_providers WHERE user_id = $1 AND provider = $2',
      [userId, provider]
    );

    if (existingLink.rowCount > 0) {
      return JSON.stringify({
        success: false,
        code: AUTH_ERROR_CODES.PROVIDER_ALREADY_LINKED,
        error: `You have already linked a ${provider} account`
      });
    }

    // Check if this provider account is already linked to another user. This is the identity-uniqueness
    // rejection required by OLO-1.2: an identity bound to a different user is never re-bound here.
    const existingProviderAccount = await connectionPool.query(
      'SELECT user_id FROM apiome.external_auth_providers WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId]
    );

    if (existingProviderAccount.rowCount > 0) {
      return JSON.stringify({
        success: false,
        code: AUTH_ERROR_CODES.IDENTITY_LINKED_ELSEWHERE,
        error: 'This provider account is already linked to another user'
      });
    }

    // Insert the linked account
    const result = await connectionPool.query(
      `INSERT INTO apiome.external_auth_providers (
        user_id, provider, provider_user_id, provider_email, email_verified, provider_username,
        access_token, refresh_token, token_expires_at, profile_data, last_login_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING id, provider, provider_username, provider_email, email_verified`,
      [
        userId,
        provider,
        providerUserId,
        providerEmail,
        emailVerified,
        providerUsername,
        accessToken,
        refreshToken,
        tokenExpiresAt,
        profileData ? JSON.stringify(profileData) : null
      ]
    );

    return JSON.stringify({
      success: true,
      linkedAccount: result.rows[0]
    });
  } catch (error: any) {
    console.error('Error linking external account:', error);
    if (error.code === '23505') { // Unique constraint violation
      return JSON.stringify({
        success: false,
        code: AUTH_ERROR_CODES.IDENTITY_LINKED_ELSEWHERE,
        error: 'This account is already linked'
      });
    }
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Whether the user has a usable password sign-in method.
 *
 * `apiome.users.password` is `NOT NULL`, but OAuth-provisioned accounts are stored with an
 * empty string (no usable credential — see `oauth-signup-actions.ts`), and credentials login
 * treats a falsy password as "no password" (`lib/auth/credentials.ts`). So "has a usable
 * password" means the column is a non-empty value. Used by the last-sign-in-method guard
 * (OLO-2.4) and surfaced to the linked-accounts panel so it can pre-disable the final unlink.
 *
 * @param userId The user whose credential state to check.
 * @returns JSON string `{ hasPassword: boolean }`; `hasPassword` is false on error (fail-safe:
 *   the guard then treats the account as password-less and refuses the last unlink).
 */
export async function getUserHasPassword(userId: string) {
  try {
    const authedUserId = await resolveOwnLinkedAccountUserId(userId);
    if (!authedUserId) {
      // Fail-safe: an unauthenticated / cross-user caller learns nothing and the
      // last-unlink guard treats the account as password-less.
      return JSON.stringify({ hasPassword: false });
    }
    const result = await connectionPool.query(
      "SELECT (password IS NOT NULL AND password <> '') AS has_password FROM apiome.users WHERE id = $1",
      [authedUserId]
    );
    if (result.rowCount === 0) {
      return JSON.stringify({ hasPassword: false });
    }
    return JSON.stringify({ hasPassword: !!result.rows[0].has_password });
  } catch (error: any) {
    console.error('Error checking user password state:', error);
    return JSON.stringify({ hasPassword: false });
  }
}

/**
 * Unlinks an external OAuth identity from a user, guarding the last sign-in method (OLO-2.4).
 *
 * A user must always retain at least one way to sign in. Sign-in methods are the user's linked
 * external identities plus a usable password (`getUserHasPassword`). The unlink is refused —
 * with the stable `last-sign-in-method` code — when it would remove the user's only remaining
 * method (their last linked identity and they have no usable password), because that would lock
 * them out of their own account.
 *
 * The check and delete run in one transaction with `SELECT ... FOR UPDATE` on the user row, so
 * two concurrent unlinks of a user's last two identities cannot both pass the count check and
 * strand the account.
 *
 * @param userId The owning user.
 * @param linkedAccountId The `external_auth_providers.id` of the identity to remove.
 * @returns JSON string. On success `{ success: true, provider }`. On refusal
 *   `{ success: false, code, error }` (`code` is `last-sign-in-method` for the guard; other
 *   failures — not found / not owned — carry only `error`).
 */
export async function unlinkExternalAccount(userId: string, linkedAccountId: string) {
  const authedUserId = await resolveOwnLinkedAccountUserId(userId);
  if (!authedUserId) {
    // Same wording as the not-owned case below so the response never reveals whether
    // the target account exists for another user.
    return JSON.stringify({
      success: false,
      error: 'Linked account not found or does not belong to you'
    });
  }
  userId = authedUserId;
  const client = await connectionPool.connect();
  try {
    await client.query('BEGIN');

    // Lock the user row so concurrent unlinks for this user serialize through the same lock —
    // this is what makes the "keep at least one method" count race-free.
    const userResult = await client.query(
      'SELECT password FROM apiome.users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (userResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return JSON.stringify({
        success: false,
        error: 'Linked account not found or does not belong to you'
      });
    }
    const storedPassword = userResult.rows[0].password;
    const hasUsablePassword = typeof storedPassword === 'string' && storedPassword.length > 0;

    // Confirm the identity exists and belongs to this user before we count anything.
    const ownership = await client.query(
      'SELECT id FROM apiome.external_auth_providers WHERE id = $1 AND user_id = $2',
      [linkedAccountId, userId]
    );
    if (ownership.rowCount === 0) {
      await client.query('ROLLBACK');
      return JSON.stringify({
        success: false,
        error: 'Linked account not found or does not belong to you'
      });
    }

    // Count the user's linked identities. When the password is not a usable method, the linked
    // identities are the only sign-in methods, so the last one must not be removed.
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM apiome.external_auth_providers WHERE user_id = $1',
      [userId]
    );
    const identityCount = countResult.rows[0].count as number;

    if (identityCount <= 1 && !hasUsablePassword) {
      await client.query('ROLLBACK');
      return JSON.stringify({
        success: false,
        code: AUTH_ERROR_CODES.LAST_SIGN_IN_METHOD,
        error:
          'This is your only sign-in method. Set a password or link another provider before unlinking it, so you keep access to your account.'
      });
    }

    const deleted = await client.query(
      'DELETE FROM apiome.external_auth_providers WHERE id = $1 AND user_id = $2 RETURNING provider',
      [linkedAccountId, userId]
    );
    await client.query('COMMIT');

    return JSON.stringify({
      success: true,
      provider: deleted.rows[0].provider
    });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Error unlinking external account:', error);
    return JSON.stringify({ success: false, error: error.message });
  } finally {
    client.release();
  }
}

export async function getLinkedAccountByProvider(provider: string, providerUserId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, user_id, provider, provider_user_id, provider_email, email_verified, provider_username,
              access_token, refresh_token, token_expires_at, profile_data,
              created_at, last_login_at
       FROM apiome.external_auth_providers
       WHERE provider = $1 AND provider_user_id = $2`,
      [provider, providerUserId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ found: false });
    }

    return JSON.stringify({ found: true, account: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching linked account by provider:', error);
    return JSON.stringify({ found: false, error: error.message });
  }
}

export async function getLinkedAccountByProviderForUser(userId: string, provider: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, provider, provider_user_id, provider_email, email_verified, provider_username,
              access_token, refresh_token, token_expires_at, profile_data,
              created_at, last_login_at
       FROM apiome.external_auth_providers
       WHERE user_id = $1 AND provider = $2`,
      [userId, provider]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ found: false });
    }

    return JSON.stringify({ found: true, account: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching linked account by provider for user:', error);
    return JSON.stringify({ found: false, error: error.message });
  }
}

/**
 * Refreshes the identity's per-sign-in columns. `last_login_at` is always stamped; when the current
 * OAuth response carries them, `provider_email` and `email_verified` are refreshed too so these
 * columns stay populated on *every* sign-in (OLO-1.2), not just the first link. Passing `undefined`
 * for either leaves the stored value untouched (COALESCE), so a provider response that omits the
 * email never blanks a previously-known one.
 */
export async function updateLinkedAccountLastLogin(
  provider: string,
  providerUserId: string,
  providerEmail?: string | null,
  emailVerified?: boolean
) {
  try {
    await connectionPool.query(
      `UPDATE apiome.external_auth_providers
       SET last_login_at = CURRENT_TIMESTAMP,
           provider_email = COALESCE($3, provider_email),
           email_verified = COALESCE($4, email_verified)
       WHERE provider = $1 AND provider_user_id = $2`,
      [
        provider,
        providerUserId,
        providerEmail === undefined ? null : providerEmail,
        emailVerified === undefined ? null : emailVerified,
      ]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error updating last login:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function getLinkedAccountById(accountId: string, userId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, user_id, provider, provider_user_id, provider_email, email_verified, provider_username,
              access_token, refresh_token, token_expires_at, profile_data,
              created_at, last_login_at
       FROM apiome.external_auth_providers
       WHERE id = $1 AND user_id = $2`,
      [accountId, userId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ found: false, error: 'Account not found or does not belong to user' });
    }

    return JSON.stringify({ found: true, account: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching linked account by ID:', error);
    return JSON.stringify({ found: false, error: error.message });
  }
}

// Personal Access Token (PAT) Management Functions

export async function addPersonalAccessToken(
  userId: string,
  accountId: string,
  accessToken: string
) {
  try {
    const authedUserId = await resolveOwnLinkedAccountUserId(userId);
    if (!authedUserId) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }
    userId = authedUserId;
    // Update the existing OAuth account with PAT
    // This adds the PAT to an already-linked account
    const result = await connectionPool.query(
      `UPDATE apiome.external_auth_providers 
       SET access_token = $1, last_login_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING id, provider, provider_username, provider_email`,
      [accessToken, accountId, userId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }

    return JSON.stringify({
      success: true,
      linkedAccount: result.rows[0]
    });
  } catch (error: any) {
    console.error('Error adding personal access token:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updatePersonalAccessToken(
  userId: string,
  accountId: string,
  accessToken: string
) {
  try {
    const authedUserId = await resolveOwnLinkedAccountUserId(userId);
    if (!authedUserId) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }
    userId = authedUserId;
    // Verify the account belongs to this user and update the token
    const result = await connectionPool.query(
      `UPDATE apiome.external_auth_providers 
       SET access_token = $1, last_login_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING id, provider`,
      [accessToken, accountId, userId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }

    return JSON.stringify({
      success: true,
      provider: result.rows[0].provider
    });
  } catch (error: any) {
    console.error('Error updating personal access token:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function removePersonalAccessToken(
  userId: string,
  accountId: string
) {
  try {
    const authedUserId = await resolveOwnLinkedAccountUserId(userId);
    if (!authedUserId) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }
    userId = authedUserId;
    // Verify the account belongs to this user and remove the PAT by setting it to null
    const result = await connectionPool.query(
      `UPDATE apiome.external_auth_providers 
       SET access_token = NULL
       WHERE id = $1 AND user_id = $2
       RETURNING id, provider`,
      [accountId, userId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({
        success: false,
        error: 'Account not found or does not belong to you'
      });
    }

    return JSON.stringify({
      success: true,
      provider: result.rows[0].provider
    });
  } catch (error: any) {
    console.error('Error removing personal access token:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

// =============================================================================
// TAG MANAGEMENT FUNCTIONS
// =============================================================================

export async function getTagsForProject(projectId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, project_id, name, color, description, created_at, updated_at
       FROM apiome.tags
       WHERE project_id = $1
       ORDER BY name ASC`,
      [projectId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching tags:', error);
    return JSON.stringify([]);
  }
}

export async function getTagsForClass(classId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
              t.name as tag_name, t.color as tag_color, t.description as tag_description,
              t.project_id
       FROM apiome.class_tags ct
       JOIN apiome.tags t ON ct.tag_id = t.id
       WHERE ct.class_id = $1
       ORDER BY t.name ASC`,
      [classId]
    );

    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching class tags:', error);
    return JSON.stringify([]);
  }
}

export async function createTag(projectId: string, name: string, color: string = 'default', description: string | null = null) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Tag name is required' });
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.tags (project_id, name, color, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, name, color, description, created_at, updated_at`,
      [projectId, name.trim(), color, description]
    );

    return JSON.stringify({ success: true, tag: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating tag:', error);

    // Handle unique constraint violation (duplicate name in same project)
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A tag with this name already exists in this project' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateTag(tagId: string, name: string | null = null, color: string | null = null, description: string | null = null) {
  try {
    // Build dynamic update query
    const updates: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (name !== null) {
      if (name.trim().length === 0) {
        return JSON.stringify({ success: false, error: 'Tag name cannot be empty' });
      }
      updates.push(`name = $${paramIndex}`);
      params.push(name.trim());
      paramIndex++;
    }

    if (color !== null) {
      updates.push(`color = $${paramIndex}`);
      params.push(color);
      paramIndex++;
    }

    if (description !== null) {
      updates.push(`description = $${paramIndex}`);
      params.push(description);
      paramIndex++;
    }

    if (updates.length === 0) {
      // Nothing to update, just return current tag
      const currentTag = await connectionPool.query(
        `SELECT id, project_id, name, color, description, created_at, updated_at
         FROM apiome.tags WHERE id = $1`,
        [tagId]
      );
      if (currentTag.rowCount === 0) {
        return JSON.stringify({ success: false, error: 'Tag not found' });
      }
      return JSON.stringify({ success: true, tag: currentTag.rows[0] });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(tagId);

    const result = await connectionPool.query(
      `UPDATE apiome.tags
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING id, project_id, name, color, description, created_at, updated_at`,
      params
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Tag not found' });
    }

    return JSON.stringify({ success: true, tag: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating tag:', error);

    // Handle unique constraint violation
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A tag with this name already exists in this project' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function deleteTag(tagId: string) {
  try {
    // Hard delete - will cascade delete class_tags due to FK constraint
    const result = await connectionPool.query(
      `DELETE FROM apiome.tags WHERE id = $1 RETURNING id`,
      [tagId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Tag not found' });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error deleting tag:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function assignTagToClass(classId: string, tagId: string) {
  try {
    const result = await connectionPool.query(
      `INSERT INTO apiome.class_tags (class_id, tag_id)
       VALUES ($1, $2)
       ON CONFLICT (class_id, tag_id) DO NOTHING
       RETURNING id, class_id, tag_id, created_at`,
      [classId, tagId]
    );

    // If conflict, fetch existing record
    if (result.rowCount === 0) {
      const existing = await connectionPool.query(
        `SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
                t.name as tag_name, t.color as tag_color
         FROM apiome.class_tags ct
         JOIN apiome.tags t ON ct.tag_id = t.id
         WHERE ct.class_id = $1 AND ct.tag_id = $2`,
        [classId, tagId]
      );
      if (existing.rowCount > 0) {
        return JSON.stringify({ success: true, class_tag: existing.rows[0], already_existed: true });
      }
    }

    // Get tag info for the newly created relationship
    const tagInfo = await connectionPool.query(
      `SELECT ct.id, ct.class_id, ct.tag_id, ct.created_at,
              t.name as tag_name, t.color as tag_color
       FROM apiome.class_tags ct
       JOIN apiome.tags t ON ct.tag_id = t.id
       WHERE ct.id = $1`,
      [result.rows[0].id]
    );

    return JSON.stringify({ success: true, class_tag: tagInfo.rows[0] });
  } catch (error: any) {
    console.error('Error assigning tag to class:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function removeTagFromClass(classId: string, tagId: string) {
  try {
    const result = await connectionPool.query(
      `DELETE FROM apiome.class_tags WHERE class_id = $1 AND tag_id = $2 RETURNING id`,
      [classId, tagId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Tag assignment not found' });
    }

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error removing tag from class:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

// =============================================================================
// PROPERTY TEMPLATES
// =============================================================================

export interface PropertyTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema: any;
  tags: string[];
  tenant_id: string | null;
  created_by: string | null;
  is_system: boolean;
  is_public: boolean;
  usage_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface PropertyTemplateCategory {
  category: string;
  count: number;
}

/**
 * Get all property templates visible to a tenant
 * Returns system templates + tenant's own templates + public templates from other tenants
 */
export async function getPropertyTemplates(tenantId?: string | null, category?: string | null) {
  try {
    let query = `
      SELECT id, name, description, category, schema, tags, tenant_id, created_by,
             is_system, is_public, usage_count, enabled, created_at, updated_at
      FROM apiome.property_templates
      WHERE deleted_at IS NULL AND enabled = true
        AND (
          is_system = true 
          OR is_public = true
          ${tenantId ? 'OR tenant_id = $1' : ''}
        )
    `;

    const params: any[] = [];
    if (tenantId) {
      params.push(tenantId);
    }

    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }

    query += ' ORDER BY is_system DESC, category, usage_count DESC, name';

    const result = await connectionPool.query(query, params);
    return JSON.stringify({ success: true, templates: result.rows });
  } catch (error: any) {
    console.error('Error fetching property templates:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Get property template categories with counts
 */
export async function getPropertyTemplateCategories(tenantId?: string | null) {
  try {
    let query = `
      SELECT category, COUNT(*) as count
      FROM apiome.property_templates
      WHERE deleted_at IS NULL AND enabled = true
        AND (
          is_system = true 
          OR is_public = true
          ${tenantId ? 'OR tenant_id = $1' : ''}
        )
      GROUP BY category
      ORDER BY category
    `;

    const params = tenantId ? [tenantId] : [];
    const result = await connectionPool.query(query, params);
    return JSON.stringify({ success: true, categories: result.rows });
  } catch (error: any) {
    console.error('Error fetching property template categories:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Search property templates by name, description, or tags
 */
export async function searchPropertyTemplates(
  searchQuery: string,
  tenantId?: string | null,
  category?: string | null
) {
  try {
    const params: any[] = [searchQuery];
    let paramIndex = 2;

    let query = `
      SELECT id, name, description, category, schema, tags, tenant_id, created_by,
             is_system, is_public, usage_count, enabled, created_at, updated_at,
             ts_rank(to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(description, '')), 
                     plainto_tsquery('english', $1)) as rank
      FROM apiome.property_templates
      WHERE deleted_at IS NULL AND enabled = true
        AND (
          is_system = true 
          OR is_public = true
          ${tenantId ? `OR tenant_id = $${paramIndex++}` : ''}
        )
        AND (
          to_tsvector('english', COALESCE(name, '') || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', $1)
          OR name ILIKE '%' || $1 || '%'
          OR $1 = ANY(tags)
        )
    `;

    if (tenantId) {
      params.push(tenantId);
    }

    if (category) {
      params.push(category);
      query += ` AND category = $${paramIndex++}`;
    }

    query += ' ORDER BY rank DESC, is_system DESC, usage_count DESC, name';

    const result = await connectionPool.query(query, params);
    return JSON.stringify({ success: true, templates: result.rows });
  } catch (error: any) {
    console.error('Error searching property templates:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Get a single property template by ID
 */
export async function getPropertyTemplateById(templateId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, name, description, category, schema, tags, tenant_id, created_by,
              is_system, is_public, usage_count, enabled, created_at, updated_at
       FROM apiome.property_templates
       WHERE id = $1 AND deleted_at IS NULL`,
      [templateId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Template not found' });
    }

    return JSON.stringify({ success: true, template: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching property template:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Create a custom property template for a tenant
 */
export async function createPropertyTemplate(
  tenantId: string,
  createdBy: string,
  name: string,
  description: string | null,
  category: string,
  schema: any,
  tags: string[] = [],
  isPublic: boolean = false
) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Template name is required' });
    }

    if (!category || category.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Category is required' });
    }

    if (!schema) {
      return JSON.stringify({ success: false, error: 'Schema is required' });
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.property_templates 
       (tenant_id, created_by, name, description, category, schema, tags, is_system, is_public)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
       RETURNING id, name, description, category, schema, tags, tenant_id, created_by,
                 is_system, is_public, usage_count, enabled, created_at, updated_at`,
      [tenantId, createdBy, name.trim(), description, category.trim(), JSON.stringify(schema), tags, isPublic]
    );

    return JSON.stringify({ success: true, template: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating property template:', error);

    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A template with this name already exists in this category' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Update a custom property template (only owner can update, system templates cannot be updated)
 */
export async function updatePropertyTemplate(
  templateId: string,
  tenantId: string,
  name: string,
  description: string | null,
  category: string,
  schema: any,
  tags: string[] = [],
  isPublic: boolean = false
) {
  try {
    // Check if template exists and is editable
    const existing = await connectionPool.query(
      `SELECT is_system, tenant_id FROM apiome.property_templates WHERE id = $1 AND deleted_at IS NULL`,
      [templateId]
    );

    if (existing.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Template not found' });
    }

    if (existing.rows[0].is_system) {
      return JSON.stringify({ success: false, error: 'System templates cannot be modified' });
    }

    if (existing.rows[0].tenant_id !== tenantId) {
      return JSON.stringify({ success: false, error: 'You can only edit templates owned by your tenant' });
    }

    const result = await connectionPool.query(
      `UPDATE apiome.property_templates 
       SET name = $1, description = $2, category = $3, schema = $4, tags = $5, 
           is_public = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 AND deleted_at IS NULL
       RETURNING id, name, description, category, schema, tags, tenant_id, created_by,
                 is_system, is_public, usage_count, enabled, created_at, updated_at`,
      [name.trim(), description, category.trim(), JSON.stringify(schema), tags, isPublic, templateId]
    );

    return JSON.stringify({ success: true, template: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating property template:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Delete a custom property template (soft delete)
 */
export async function deletePropertyTemplate(templateId: string, tenantId: string) {
  try {
    // Check if template exists and is deletable
    const existing = await connectionPool.query(
      `SELECT is_system, tenant_id FROM apiome.property_templates WHERE id = $1 AND deleted_at IS NULL`,
      [templateId]
    );

    if (existing.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Template not found' });
    }

    if (existing.rows[0].is_system) {
      return JSON.stringify({ success: false, error: 'System templates cannot be deleted' });
    }

    if (existing.rows[0].tenant_id !== tenantId) {
      return JSON.stringify({ success: false, error: 'You can only delete templates owned by your tenant' });
    }

    await connectionPool.query(
      `UPDATE apiome.property_templates SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [templateId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error deleting property template:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Increment usage count when a template is used
 */
export async function incrementTemplateUsage(templateId: string) {
  try {
    await connectionPool.query(
      `UPDATE apiome.property_templates SET usage_count = usage_count + 1 WHERE id = $1`,
      [templateId]
    );
    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error incrementing template usage:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Use a property template: creates a property in the project from the template
 * Returns the created property
 */
export async function usePropertyTemplate(
  templateId: string,
  projectId: string,
  customName?: string | null
) {
  try {
    // Get the template
    const templateResult = await connectionPool.query(
      `SELECT id, name, description, schema FROM apiome.property_templates 
       WHERE id = $1 AND deleted_at IS NULL AND enabled = true`,
      [templateId]
    );

    if (templateResult.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Template not found' });
    }

    const template = templateResult.rows[0];
    const propertyName = customName?.trim() || template.name;

    // Check if property with this name already exists in the project
    const existingCheck = await connectionPool.query(
      `SELECT id FROM apiome.properties WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [projectId, propertyName]
    );

    if (existingCheck.rowCount > 0) {
      return JSON.stringify({
        success: false,
        error: `A property named "${propertyName}" already exists in this project`
      });
    }

    // Create the property from the template
    const propertyResult = await connectionPool.query(
      `INSERT INTO apiome.properties (project_id, name, description, data)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, name, description, data, enabled, created_at, updated_at`,
      [projectId, propertyName, template.description, template.schema]
    );

    // Increment template usage count
    await connectionPool.query(
      `UPDATE apiome.property_templates SET usage_count = usage_count + 1 WHERE id = $1`,
      [templateId]
    );

    return JSON.stringify({ success: true, property: propertyResult.rows[0] });
  } catch (error: any) {
    console.error('Error using property template:', error);

    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A property with this name already exists in the project' });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

// =============================================================================
// CANVAS LAYOUT FUNCTIONS
// =============================================================================

/**
 * Get all canvas layouts for a version
 */
export async function getCanvasLayoutsForVersion(versionId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, version_id, user_id, name, is_default, viewport, nodes, edges, 
              grid_settings, minimap_settings, metadata, created_at, updated_at
       FROM apiome.canvas_layouts 
       WHERE version_id = $1 
       ORDER BY is_default DESC, updated_at DESC`,
      [versionId]
    );
    return JSON.stringify(result.rows);
  } catch (error: any) {
    console.error('Error fetching canvas layouts:', error);
    return JSON.stringify([]);
  }
}

/**
 * Get a specific canvas layout by ID
 */
export async function getCanvasLayout(layoutId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, version_id, user_id, name, is_default, viewport, nodes, edges, 
              grid_settings, minimap_settings, metadata, created_at, updated_at
       FROM apiome.canvas_layouts 
       WHERE id = $1`,
      [layoutId]
    );
    if (result.rowCount === 0) {
      return errorResponse('Layout not found');
    }
    return successResponse({ layout: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Get the default canvas layout for a version (optionally user-specific)
 */
export async function getDefaultCanvasLayout(versionId: string, userId?: string) {
  try {
    // First try to get user-specific default layout
    if (userId) {
      const userResult = await connectionPool.query(
        `SELECT id, version_id, user_id, name, is_default, viewport, nodes, edges,
                grid_settings, minimap_settings, metadata, created_at, updated_at
         FROM apiome.canvas_layouts 
         WHERE version_id = $1 AND user_id = $2 AND is_default = true`,
        [versionId, userId]
      );
      if (userResult.rowCount > 0) {
        return successResponse({ layout: userResult.rows[0] });
      }
    }

    // Fall back to shared default layout (user_id IS NULL)
    const sharedResult = await connectionPool.query(
      `SELECT id, version_id, user_id, name, is_default, viewport, nodes, edges,
              grid_settings, minimap_settings, metadata, created_at, updated_at
       FROM apiome.canvas_layouts 
       WHERE version_id = $1 AND user_id IS NULL AND is_default = true`,
      [versionId]
    );

    if (sharedResult.rowCount > 0) {
      return successResponse({ layout: sharedResult.rows[0] });
    }

    return successResponse({ layout: null });
  } catch (error: any) {
    console.error('Error fetching default canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Resolve which named layout to prefer on first open: user → tenant → built-in "Development Layout".
 */
export async function getEffectiveDefaultLayoutName(
  versionId: string,
  userId: string | undefined,
  tenantId: string | undefined
) {
  try {
    if (userId) {
      const userRow = await connectionPool.query(
        `SELECT layout_name FROM apiome.user_canvas_layout_defaults
         WHERE user_id = $1 AND version_id = $2`,
        [userId, versionId]
      );
      if (userRow.rowCount && userRow.rows[0].layout_name) {
        const n = String(userRow.rows[0].layout_name).trim();
        if (n) {
          return successResponse({ layoutName: n });
        }
      }
    }
    if (tenantId) {
      const tenantRow = await connectionPool.query(
        `SELECT layout_name FROM apiome.tenant_canvas_layout_defaults
         WHERE tenant_id = $1 AND version_id = $2`,
        [tenantId, versionId]
      );
      if (tenantRow.rowCount && tenantRow.rows[0].layout_name) {
        const n = String(tenantRow.rows[0].layout_name).trim();
        if (n) {
          return successResponse({ layoutName: n });
        }
      }
    }
    return successResponse({ layoutName: 'Development Layout' });
  } catch (error: any) {
    console.error('Error resolving default layout name:', error);
    return errorResponse(error.message);
  }
}

export async function isTenantAdmin(tenantId: string) {
  try {
    const session = await getAuthSession();
    const userId = (session?.user as any)?.user_id;
    if (!userId) {
      return successResponse({ isAdmin: false });
    }
    const result = await connectionPool.query(
      `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId]
    );
    return successResponse({ isAdmin: Boolean(result.rowCount) });
  } catch (error: any) {
    console.error('Error checking tenant admin status:', error);
    return errorResponse(error.message);
  }
}

export async function setUserCanvasLayoutDefaultName(versionId: string, layoutName: string) {
  const session = await getAuthSession();
  const userId = (session?.user as any)?.user_id;
  if (!userId) {
    return errorResponse('Unauthorized');
  }
  const name = layoutName.trim();
  if (!name) {
    return errorResponse('Layout name is required');
  }
  try {
    await connectionPool.query(
      `INSERT INTO apiome.user_canvas_layout_defaults (user_id, version_id, layout_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, version_id) DO UPDATE
       SET layout_name = EXCLUDED.layout_name, updated_at = CURRENT_TIMESTAMP`,
      [userId, versionId, name]
    );
    return successResponse({ layoutName: name });
  } catch (error: any) {
    console.error('Error saving user default layout name:', error);
    return errorResponse(error.message);
  }
}

export async function clearUserCanvasLayoutDefaultName(versionId: string) {
  const session = await getAuthSession();
  const userId = (session?.user as any)?.user_id;
  if (!userId) {
    return errorResponse('Unauthorized');
  }
  try {
    await connectionPool.query(
      `DELETE FROM apiome.user_canvas_layout_defaults WHERE user_id = $1 AND version_id = $2`,
      [userId, versionId]
    );
    return successResponse();
  } catch (error: any) {
    console.error('Error clearing user default layout name:', error);
    return errorResponse(error.message);
  }
}

export async function setTenantCanvasLayoutDefaultName(
  versionId: string,
  tenantId: string,
  layoutName: string
) {
  const session = await getAuthSession();
  const actingUserId = (session?.user as any)?.user_id;
  if (!actingUserId) {
    return errorResponse('Unauthorized');
  }
  const name = layoutName.trim();
  if (!name) {
    return errorResponse('Layout name is required');
  }
  try {
    const adminCheck = await connectionPool.query(
      `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, actingUserId]
    );
    if (!adminCheck.rowCount) {
      return errorResponse('Only tenant administrators can set the team default layout name');
    }
    const verCheck = await connectionPool.query(
      `SELECT 1 FROM apiome.versions v
       INNER JOIN apiome.projects p ON v.project_id = p.id
       WHERE v.id = $1 AND p.tenant_id = $2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [versionId, tenantId]
    );
    if (!verCheck.rowCount) {
      return errorResponse('Version not found for this tenant');
    }
    await connectionPool.query(
      `INSERT INTO apiome.tenant_canvas_layout_defaults (tenant_id, version_id, layout_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, version_id) DO UPDATE
       SET layout_name = EXCLUDED.layout_name, updated_at = CURRENT_TIMESTAMP`,
      [tenantId, versionId, name]
    );
    return successResponse({ layoutName: name });
  } catch (error: any) {
    console.error('Error saving tenant default layout name:', error);
    return errorResponse(error.message);
  }
}

export async function clearTenantCanvasLayoutDefaultName(
  versionId: string,
  tenantId: string
) {
  const session = await getAuthSession();
  const actingUserId = (session?.user as any)?.user_id;
  if (!actingUserId) {
    return errorResponse('Unauthorized');
  }
  try {
    const adminCheck = await connectionPool.query(
      `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, actingUserId]
    );
    if (!adminCheck.rowCount) {
      return errorResponse('Only tenant administrators can clear the team default layout name');
    }
    await connectionPool.query(
      `DELETE FROM apiome.tenant_canvas_layout_defaults WHERE tenant_id = $1 AND version_id = $2`,
      [tenantId, versionId]
    );
    return successResponse();
  } catch (error: any) {
    console.error('Error clearing tenant default layout name:', error);
    return errorResponse(error.message);
  }
}

/**
 * Atomically pin a quick snapshot as the shared team-default named layout for a version (#175).
 * Derives the acting user from the session — never from a client-supplied parameter.
 * Only tenant administrators of the owning tenant may call this action.
 * Groups are intentionally excluded to avoid overwriting live group positions for all members.
 */
export async function pinTeamDefaultQuickSnapshot(
  versionId: string,
  tenantId: string,
  viewport: any,
  nodes: any,
  edges?: any,
  snapshotPngBase64?: string
) {
  const session = await getAuthSession();
  const actingUserId = (session?.user as any)?.user_id;
  if (!actingUserId) {
    return errorResponse('Unauthorized');
  }
  try {
    const adminCheck = await connectionPool.query(
      `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, actingUserId]
    );
    if (!adminCheck.rows.length) {
      return errorResponse('Only tenant administrators can pin a team default layout');
    }
    const verCheck = await connectionPool.query(
      `SELECT 1 FROM apiome.versions v
       INNER JOIN apiome.projects p ON v.project_id = p.id
       WHERE v.id = $1 AND p.tenant_id = $2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [versionId, tenantId]
    );
    if (!verCheck.rows.length) {
      return errorResponse('Version not found for this tenant');
    }

    let snapshotBuffer: Buffer | undefined;
    if (snapshotPngBase64 !== undefined && snapshotPngBase64.trim() !== '') {
      const parsed = parseLayoutSnapshotBase64(snapshotPngBase64);
      if (!parsed.ok) {
        return errorResponse(parsed.error);
      }
      snapshotBuffer = parsed.buffer;
    }

    const name = TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME;

    // Upsert the shared (user_id = null) layout without touching group positions.
    const existingResult = await connectionPool.query(
      `SELECT id FROM apiome.canvas_layouts
       WHERE version_id = $1 AND name = $2 AND user_id IS NULL
       LIMIT 1`,
      [versionId, name]
    );

    if (existingResult.rowCount > 0) {
      const updates: { viewport: any; nodes: any; edges: any; snapshotImage?: Buffer } = {
        viewport,
        nodes,
        edges: edges || [],
      };
      if (snapshotBuffer !== undefined) {
        updates.snapshotImage = snapshotBuffer;
      }
      const updateResult = await updateCanvasLayout(
        existingResult.rows[0].id,
        updates,
        { recordRevision: true, revisionUserId: actingUserId }
      );
      const updateParsed = JSON.parse(updateResult);
      if (!updateParsed.success) {
        return errorResponse(updateParsed.error || 'Failed to update shared layout');
      }
    } else {
      const createResult = await createCanvasLayout(
        versionId,
        null,
        name,
        false,
        viewport,
        nodes,
        edges || [],
        null,
        { enabled: true, size: 20, snapToGrid: true, showGrid: true },
        { enabled: true, position: 'bottom-right', size: 'medium' },
        {},
        snapshotBuffer ?? null
      );
      const createParsed = JSON.parse(createResult);
      if (!createParsed.success) {
        return errorResponse(createParsed.error || 'Failed to create shared layout');
      }
    }

    // Set tenant canvas layout default atomically.
    await connectionPool.query(
      `INSERT INTO apiome.tenant_canvas_layout_defaults (tenant_id, version_id, layout_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, version_id) DO UPDATE
       SET layout_name = EXCLUDED.layout_name, updated_at = CURRENT_TIMESTAMP`,
      [tenantId, versionId, name]
    );
    return successResponse({ layoutName: name });
  } catch (error: any) {
    console.error('Error pinning team default quick snapshot:', error);
    return errorResponse(error.message);
  }
}

/**
 * Get all named canvas layouts for a version, preferring user-specific layouts.
 * Returns at most one layout per name.
 */
export async function getNamedCanvasLayoutsForVersion(versionId: string, userId?: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, version_id, user_id, name, is_default, metadata, snapshot_image, created_at, updated_at
       FROM apiome.canvas_layouts
       WHERE version_id = $1
         AND name IS NOT NULL
         AND is_default = false
         AND (user_id = $2 OR user_id IS NULL)
       ORDER BY name ASC, (user_id = $2) DESC NULLS LAST, updated_at DESC`,
      [versionId, userId || null]
    );

    const byName = new Map<string, any>();
    result.rows.forEach((row: any) => {
      if (!row.name || typeof row.name !== 'string') return;
      const normalizedName = row.name.trim();
      if (!normalizedName) return;
      if (!byName.has(normalizedName)) {
        const snapshotImageBase64 =
          row.snapshot_image && Buffer.isBuffer(row.snapshot_image)
            ? row.snapshot_image.toString('base64')
            : undefined;
        byName.set(normalizedName, {
          ...layoutRowWithoutBinarySnapshot(row),
          name: normalizedName,
          ...(snapshotImageBase64 ? { snapshotImageBase64 } : {})
        });
      }
    });

    return successResponse({ layouts: Array.from(byName.values()) });
  } catch (error: any) {
    console.error('Error fetching named canvas layouts:', error);
    return errorResponse(error.message);
  }
}

/**
 * Get a named canvas layout for a version, preferring user-specific layout.
 * For the reserved team-default name, always loads the shared (user_id = null) layout so that
 * a personal layout saved with the same name cannot shadow the team default.
 */
export async function getNamedCanvasLayout(versionId: string, userId: string | null, name: string) {
  try {
    const nameValue = name.trim();
    if (!nameValue) {
      return successResponse({ layout: null });
    }

    // The pinned team-default is always shared; never allow a personal row to shadow it.
    const isReserved = nameValue === TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME;
    const effectiveUserId = isReserved ? null : userId;

    const result = await connectionPool.query(
      `SELECT id, version_id, user_id, name, is_default, viewport, nodes, edges,
              grid_settings, minimap_settings, metadata, snapshot_image, created_at, updated_at
       FROM apiome.canvas_layouts
       WHERE version_id = $1
         AND name = $2
         AND (user_id = $3 OR user_id IS NULL)
       ORDER BY (user_id = $3) DESC NULLS LAST, updated_at DESC
       LIMIT 1`,
      [versionId, nameValue, effectiveUserId]
    );

    if (result.rowCount === 0) {
      return successResponse({ layout: null });
    }

    const raw = result.rows[0];
    const snapshotImageBase64 =
      raw.snapshot_image && Buffer.isBuffer(raw.snapshot_image)
        ? raw.snapshot_image.toString('base64')
        : undefined;
    return successResponse({
      layout: {
        ...layoutRowWithoutBinarySnapshot(raw),
        ...(snapshotImageBase64 ? { snapshotImageBase64 } : {})
      }
    });
  } catch (error: any) {
    console.error('Error fetching named canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Save or update a named canvas layout for a version.
 */
export async function saveNamedCanvasLayout(
  versionId: string,
  userId: string | null,
  name: string,
  viewport: any,
  nodes: any,
  edges?: any,
  groups?: any,
  snapshotPngBase64?: string,
  tenantId?: string,
  annotationsInput?: NamedLayoutAnnotationsInput
) {
  try {
    const session = await getAuthSession();
    const actingUserId = (session?.user as any)?.user_id;
    if (!actingUserId) {
      return errorResponse('Unauthorized');
    }

    // Personal layout: ensure the caller cannot impersonate another user.
    if (userId !== null && userId !== actingUserId) {
      return errorResponse('You can only save layouts for your own account');
    }

    // Shared layout (userId === null): only tenant admins may create or overwrite them.
    if (userId === null) {
      const trimmedTenantId = tenantId?.trim();
      if (!trimmedTenantId) {
        return errorResponse('Tenant id is required to save shared layouts');
      }
      const tenantOwnsVersionResult = await connectionPool.query(
        `SELECT 1
         FROM apiome.versions v
         JOIN apiome.projects p ON p.id = v.project_id
         WHERE v.id = $1
           AND p.tenant_id = $2
           AND v.deleted_at IS NULL
           AND p.deleted_at IS NULL`,
        [versionId, trimmedTenantId]
      );
      if (tenantOwnsVersionResult.rowCount === 0) {
        return errorResponse('Version does not belong to the provided tenant');
      }
      const adminResult = await connectionPool.query(
        `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
        [trimmedTenantId, actingUserId]
      );
      if (adminResult.rowCount === 0) {
        return errorResponse('Only tenant administrators can save shared layouts');
      }
    }

    const nameValue = name.trim();
    if (!nameValue) {
      return errorResponse('Layout name is required');
    }

    // Prevent personal layouts from using the reserved team-default name so it cannot be shadowed.
    if (userId !== null && nameValue === TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME) {
      return errorResponse(`"${TEAM_QUICK_SNAPSHOT_PINNED_LAYOUT_NAME}" is reserved for the shared team default and cannot be used as a personal layout name`);
    }

    let snapshotBuffer: Buffer | undefined;
    if (snapshotPngBase64 !== undefined && snapshotPngBase64.trim() !== '') {
      const parsed = parseLayoutSnapshotBase64(snapshotPngBase64);
      if (!parsed.ok) {
        return errorResponse(parsed.error);
      }
      snapshotBuffer = parsed.buffer;
    }

    const existingResult = await connectionPool.query(
      `SELECT id, metadata FROM apiome.canvas_layouts
       WHERE version_id = $1
         AND name = $2
         AND user_id IS NOT DISTINCT FROM $3
       LIMIT 1`,
      [versionId, nameValue, userId]
    );
    const normalizedAnnotations = sanitizeNamedLayoutAnnotations(annotationsInput);

    // Keep group storage behavior aligned with default layout saves.
    if (groups && Array.isArray(groups)) {
      const nodePositions: Record<string, { x: number; y: number }> = {};
      if (nodes && Array.isArray(nodes)) {
        nodes.forEach((node: any) => {
          if (node.id && node.position && node.type !== 'groupNode') {
            nodePositions[node.id] = { x: node.position.x, y: node.position.y };
          }
        });
      }
      const syncResult = await syncGroupsForVersion(versionId, groups, nodePositions);
      const parsedSyncResult = JSON.parse(syncResult);
      if (!parsedSyncResult.success) {
        return errorResponse(parsedSyncResult.error || 'Failed to sync groups for layout save');
      }
    }

    if (existingResult.rowCount > 0) {
      const updates: {
        viewport: any;
        nodes: any;
        edges: any;
        metadata?: any;
        snapshotImage?: Buffer;
      } = {
        viewport,
        nodes,
        edges: edges || []
      };
      const existingMetadata =
        existingResult.rows[0]?.metadata && typeof existingResult.rows[0].metadata === 'object'
          ? existingResult.rows[0].metadata
          : {};
      const mergedMetadata: Record<string, unknown> = {
        ...existingMetadata,
      };
      // Apply metadata changes only when explicitly provided.
      // Treat empty strings as an explicit request to clear the field.
      if (annotationsInput != null) {
        if (Object.prototype.hasOwnProperty.call(annotationsInput, 'comment')) {
          if (normalizedAnnotations.comment) {
            mergedMetadata.comment = normalizedAnnotations.comment;
          } else {
            delete mergedMetadata.comment;
          }
        }
        if (Object.prototype.hasOwnProperty.call(annotationsInput, 'annotations')) {
          if (normalizedAnnotations.annotations) {
            mergedMetadata.annotations = normalizedAnnotations.annotations;
          } else {
            delete mergedMetadata.annotations;
          }
        }
      }
      updates.metadata = mergedMetadata;
      if (snapshotBuffer !== undefined) {
        updates.snapshotImage = snapshotBuffer;
      }
      return updateCanvasLayout(
        existingResult.rows[0].id,
        updates,
        { recordRevision: true, revisionUserId: userId }
      );
    }

    return createCanvasLayout(
      versionId,
      userId,
      nameValue,
      false,
      viewport,
      nodes,
      edges || [],
      null,
      { enabled: true, size: 20, snapToGrid: true, showGrid: true },
      { enabled: true, position: 'bottom-right', size: 'medium' },
      {
        ...(normalizedAnnotations.comment !== undefined ? { comment: normalizedAnnotations.comment } : {}),
        ...(normalizedAnnotations.annotations !== undefined ? { annotations: normalizedAnnotations.annotations } : {}),
      },
      snapshotBuffer ?? null
    );
  } catch (error: any) {
    console.error('Error saving named canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Create a new canvas layout
 */
export async function createCanvasLayout(
  versionId: string,
  userId: string | null,
  name: string | null,
  isDefault: boolean,
  viewport: any,
  nodes: any,
  edges: any,
  groups: any,
  gridSettings: any,
  minimapSettings: any,
  metadata: any,
  snapshotImage?: Buffer | null
) {
  try {
    // If setting as default, unset other defaults for this version/user combination
    if (isDefault) {
      if (userId) {
        await connectionPool.query(
          `UPDATE apiome.canvas_layouts SET is_default = false 
           WHERE version_id = $1 AND user_id = $2 AND is_default = true`,
          [versionId, userId]
        );
      } else {
        await connectionPool.query(
          `UPDATE apiome.canvas_layouts SET is_default = false 
           WHERE version_id = $1 AND user_id IS NULL AND is_default = true`,
          [versionId]
        );
      }
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.canvas_layouts 
       (version_id, user_id, name, is_default, viewport, nodes, edges, grid_settings, minimap_settings, metadata, snapshot_image)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, version_id, user_id, name, is_default, viewport, nodes, edges,
                 grid_settings, minimap_settings, metadata, created_at, updated_at`,
      [versionId, userId, name, isDefault,
       JSON.stringify(viewport), JSON.stringify(nodes), JSON.stringify(edges),
       JSON.stringify(gridSettings), JSON.stringify(minimapSettings), JSON.stringify(metadata),
       snapshotImage ?? null]
    );

    return successResponse({ layout: layoutRowWithoutBinarySnapshot(result.rows[0]) });
  } catch (error: any) {
    console.error('Error creating canvas layout:', error);
    return errorResponse(error.message);
  }
}

/** Max prior snapshots kept per layout row (named saves only; default auto-save does not record). */
const CANVAS_LAYOUT_REVISION_RETAIN = 50;

/**
 * Re-encode a JSONB column read back off a row before it is written to another
 * JSONB column. The driver hands back parsed JS values, and it serializes a JS
 * array as a Postgres array literal rather than as JSON — so a `nodes`/`edges`
 * array round-tripped as-is reaches the server as `{"{...}","{...}"}` and fails
 * to parse. Null stays null so a nullable column keeps SQL NULL instead of
 * picking up a JSON `null`.
 */
function encodeJsonbParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * Update an existing canvas layout.
 * @param options.recordRevision When true, stores the previous row snapshot in canvas_layout_revisions
 *   (used for named layout saves). A revision is recorded whenever spatial layout fields are provided,
 *   regardless of whether the values have actually changed.
 */
export async function updateCanvasLayout(
  layoutId: string,
  updates: {
    name?: string | null;
    isDefault?: boolean;
    viewport?: any;
    nodes?: any;
    edges?: any;
    gridSettings?: any;
    minimapSettings?: any;
    metadata?: any;
    snapshotImage?: Buffer;
  },
  options?: {
    recordRevision?: boolean;
    revisionUserId?: string | null;
  }
) {
  const client = await connectionPool.connect();
  try {
    const recordRevision = options?.recordRevision === true;
    const revisionUserId = options?.revisionUserId ?? null;

    const shouldSnapshotPriorLayout =
      recordRevision &&
      (updates.viewport !== undefined ||
        updates.nodes !== undefined ||
        updates.edges !== undefined ||
        updates.gridSettings !== undefined ||
        updates.minimapSettings !== undefined);

    await client.query('BEGIN');

    // Lock the layout row for the duration of the transaction so concurrent saves
    // for the same layout cannot race on the revision counter.
    const currentResult = await client.query(
      `SELECT * FROM apiome.canvas_layouts WHERE id = $1 FOR UPDATE`,
      [layoutId]
    );

    if (currentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return errorResponse('Layout not found');
    }

    const currentRow = currentResult.rows[0];

    if (shouldSnapshotPriorLayout) {
      // MAX(revision) is safe here because the canvas_layouts row is locked above,
      // preventing any concurrent transaction from inserting a revision for this layout.
      const maxRevResult = await client.query(
        `SELECT COALESCE(MAX(revision), 0) AS n FROM apiome.canvas_layout_revisions WHERE canvas_layout_id = $1`,
        [layoutId]
      );
      const nextRevision = Number(maxRevResult.rows[0].n) + 1;

      await client.query(
        `INSERT INTO apiome.canvas_layout_revisions
         (canvas_layout_id, revision, viewport, nodes, edges, grid_settings, minimap_settings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          layoutId,
          nextRevision,
          encodeJsonbParam(currentRow.viewport),
          encodeJsonbParam(currentRow.nodes),
          encodeJsonbParam(currentRow.edges),
          encodeJsonbParam(currentRow.grid_settings),
          encodeJsonbParam(currentRow.minimap_settings),
          revisionUserId
        ]
      );

      await client.query(
        `DELETE FROM apiome.canvas_layout_revisions
         WHERE canvas_layout_id = $1
           AND revision < (
             SELECT COALESCE(MAX(revision), 0) - $2
             FROM apiome.canvas_layout_revisions
             WHERE canvas_layout_id = $1
           )`,
        [layoutId, CANVAS_LAYOUT_REVISION_RETAIN - 1]
      );
    }

    const { version_id, user_id } = currentRow;

    // If setting as default, unset other defaults
    if (updates.isDefault) {
      if (user_id) {
        await client.query(
          `UPDATE apiome.canvas_layouts SET is_default = false 
           WHERE version_id = $1 AND user_id = $2 AND is_default = true AND id != $3`,
          [version_id, user_id, layoutId]
        );
      } else {
        await client.query(
          `UPDATE apiome.canvas_layouts SET is_default = false 
           WHERE version_id = $1 AND user_id IS NULL AND is_default = true AND id != $2`,
          [version_id, layoutId]
        );
      }
    }

    // Build dynamic update query
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.isDefault !== undefined) {
      setClauses.push(`is_default = $${paramIndex++}`);
      values.push(updates.isDefault);
    }
    if (updates.viewport !== undefined) {
      setClauses.push(`viewport = $${paramIndex++}`);
      values.push(JSON.stringify(updates.viewport));
    }
    if (updates.nodes !== undefined) {
      setClauses.push(`nodes = $${paramIndex++}`);
      values.push(JSON.stringify(updates.nodes));
    }
    if (updates.edges !== undefined) {
      setClauses.push(`edges = $${paramIndex++}`);
      values.push(JSON.stringify(updates.edges));
    }
    if (updates.gridSettings !== undefined) {
      setClauses.push(`grid_settings = $${paramIndex++}`);
      values.push(JSON.stringify(updates.gridSettings));
    }
    if (updates.minimapSettings !== undefined) {
      setClauses.push(`minimap_settings = $${paramIndex++}`);
      values.push(JSON.stringify(updates.minimapSettings));
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.snapshotImage !== undefined) {
      setClauses.push(`snapshot_image = $${paramIndex++}`);
      values.push(updates.snapshotImage);
    }

    if (setClauses.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('No updates provided');
    }

    values.push(layoutId);

    const result = await client.query(
      `UPDATE apiome.canvas_layouts 
       SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, version_id, user_id, name, is_default, viewport, nodes, edges, 
                 grid_settings, minimap_settings, metadata, created_at, updated_at`,
      values
    );

    await client.query('COMMIT');
    return successResponse({ layout: layoutRowWithoutBinarySnapshot(result.rows[0]) });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error updating canvas layout:', error);
    return errorResponse(error.message);
  } finally {
    client.release();
  }
}

/**
 * List prior snapshots for a named layout (newest first).
 * Access is restricted to layouts that belong to `versionId` and are owned by
 * `userId` or are shared (user_id IS NULL).
 */
export async function listCanvasLayoutRevisions(
  layoutId: string,
  versionId: string,
  userId: string | null,
  limit: number = 50
) {
  try {
    const cap = Math.min(Math.max(1, limit), 100);
    const result = await connectionPool.query(
      `SELECT r.id, r.canvas_layout_id, r.revision, r.created_at, r.created_by
       FROM apiome.canvas_layout_revisions r
       JOIN apiome.canvas_layouts cl ON cl.id = r.canvas_layout_id
       WHERE r.canvas_layout_id = $1
         AND cl.version_id = $2
         AND (cl.user_id = $3 OR cl.user_id IS NULL)
       ORDER BY r.revision DESC
       LIMIT $4`,
      [layoutId, versionId, userId, cap]
    );
    return successResponse({ revisions: result.rows });
  } catch (error: any) {
    console.error('Error listing canvas layout revisions:', error);
    return errorResponse(error.message);
  }
}

/**
 * Restore a canvas layout from a stored revision (records current state as a new revision first).
 * Access is restricted to layouts that belong to `versionId` and are owned by
 * `userId` or are shared (user_id IS NULL).
 */
export async function restoreCanvasLayoutFromRevision(
  layoutId: string,
  revisionId: string,
  versionId: string,
  userId: string | null
) {
  try {
    const revResult = await connectionPool.query(
      `SELECT r.viewport, r.nodes, r.edges, r.grid_settings, r.minimap_settings
       FROM apiome.canvas_layout_revisions r
       JOIN apiome.canvas_layouts cl ON cl.id = r.canvas_layout_id
       WHERE r.id = $1
         AND r.canvas_layout_id = $2
         AND cl.version_id = $3
         AND (cl.user_id = $4 OR cl.user_id IS NULL)`,
      [revisionId, layoutId, versionId, userId]
    );

    if (revResult.rowCount === 0) {
      return errorResponse('Revision not found');
    }

    const row = revResult.rows[0];
    return updateCanvasLayout(
      layoutId,
      {
        viewport: row.viewport,
        nodes: row.nodes,
        edges: row.edges,
        gridSettings: row.grid_settings,
        minimapSettings: row.minimap_settings
      },
      { recordRevision: true, revisionUserId: userId }
    );
  } catch (error: any) {
    console.error('Error restoring canvas layout revision:', error);
    return errorResponse(error.message);
  }
}

/**
 * Fetch full revision data (viewport, nodes, edges, settings) for diff comparison.
 * Access is restricted to layouts belonging to `versionId` owned by `userId` or shared.
 */
export async function getCanvasLayoutRevisionData(
  revisionId: string,
  layoutId: string,
  versionId: string
) {
  try {
    const session = await getAuthSession();
    const actingUserId = (session?.user as any)?.user_id;
    if (!actingUserId) {
      return errorResponse('Unauthorized');
    }

    const result = await connectionPool.query(
      `SELECT r.id, r.revision, r.viewport, r.nodes, r.edges,
              r.grid_settings, r.minimap_settings, r.created_at, r.created_by
       FROM apiome.canvas_layout_revisions r
       JOIN apiome.canvas_layouts cl ON cl.id = r.canvas_layout_id
       WHERE r.id = $1
         AND r.canvas_layout_id = $2
         AND cl.version_id = $3
         AND (cl.user_id = $4 OR cl.user_id IS NULL)`,
      [revisionId, layoutId, versionId, actingUserId]
    );

    if (result.rowCount === 0) {
      return errorResponse('Revision not found');
    }
    return successResponse({ revision: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching canvas layout revision data:', error);
    return errorResponse(error.message);
  }
}

/**
 * Delete a canvas layout
 */
export async function deleteCanvasLayout(layoutId: string) {
  try {
    const result = await connectionPool.query(
      `DELETE FROM apiome.canvas_layouts WHERE id = $1 RETURNING id`,
      [layoutId]
    );

    if (result.rowCount === 0) {
      return errorResponse('Layout not found');
    }

    return successResponse({ deleted: true });
  } catch (error: any) {
    console.error('Error deleting canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Delete a named layout visible to the current user.
 * - Personal layout: owner can delete.
 * - Shared layout (user_id null): tenant admins can delete when the version belongs to that tenant.
 */
export async function deleteNamedCanvasLayout(
  versionId: string,
  name: string,
  tenantId?: string
) {
  const session = await getAuthSession();
  const actingUserId = (session?.user as any)?.user_id;
  if (!actingUserId) {
    return errorResponse('Unauthorized');
  }
  const nameValue = name.trim();
  if (!nameValue) {
    return errorResponse('Layout name is required');
  }
  try {
    const candidateResult = await connectionPool.query(
      `SELECT id, user_id, name
       FROM apiome.canvas_layouts
       WHERE version_id = $1
         AND name = $2
         AND is_default = false
         AND (user_id = $3 OR user_id IS NULL)
       ORDER BY (user_id = $3) DESC NULLS LAST, updated_at DESC
       LIMIT 1`,
      [versionId, nameValue, actingUserId]
    );
    if (candidateResult.rowCount === 0) {
      return errorResponse('Layout not found');
    }
    const candidate = candidateResult.rows[0];
    const ownerUserId = candidate.user_id as string | null;

    if (ownerUserId === null) {
      const trimmedTenantId = tenantId?.trim();
      if (!trimmedTenantId) {
        return errorResponse('Tenant id is required to delete shared layouts');
      }
      const tenantOwnsVersionResult = await connectionPool.query(
        `SELECT 1
         FROM apiome.versions v
         JOIN apiome.projects p ON p.id = v.project_id
         WHERE v.id = $1
           AND p.tenant_id = $2
           AND v.deleted_at IS NULL
           AND p.deleted_at IS NULL`,
        [versionId, trimmedTenantId]
      );
      if (tenantOwnsVersionResult.rowCount === 0) {
        return errorResponse('Version does not belong to the provided tenant');
      }
      const adminResult = await connectionPool.query(
        `SELECT 1 FROM apiome.tenant_administrators WHERE tenant_id = $1 AND user_id = $2`,
        [trimmedTenantId, actingUserId]
      );
      if (adminResult.rowCount === 0) {
        return errorResponse('Only tenant administrators can delete shared layouts');
      }
    } else if (ownerUserId !== actingUserId) {
      return errorResponse('You can only delete your own layouts');
    }

    const result = await connectionPool.query(
      `DELETE FROM apiome.canvas_layouts WHERE id = $1 RETURNING id`,
      [candidate.id]
    );

    if (result.rowCount === 0) {
      return errorResponse('Layout not found');
    }
    return successResponse({ deleted: true, name: nameValue });
  } catch (error: any) {
    console.error('Error deleting named canvas layout:', error);
    return errorResponse(error.message);
  }
}

/**
 * Save or update the default canvas layout for a version
 * This is a convenience function that creates or updates the default layout
 * Note: Groups are stored separately in the groups table, use syncGroupsForVersion
 */
export async function saveDefaultCanvasLayout(
  versionId: string,
  userId: string | null,
  viewport: any,
  nodes: any,
  edges?: any,
  groups?: any
) {
  try {
    // Check if a default layout already exists
    let existingQuery: string;
    let existingParams: any[];

    if (userId) {
      existingQuery = `SELECT id FROM apiome.canvas_layouts 
                       WHERE version_id = $1 AND user_id = $2 AND is_default = true`;
      existingParams = [versionId, userId];
    } else {
      existingQuery = `SELECT id FROM apiome.canvas_layouts 
                       WHERE version_id = $1 AND user_id IS NULL AND is_default = true`;
      existingParams = [versionId];
    }

    const existingResult = await connectionPool.query(existingQuery, existingParams);

    // Sync groups to the dedicated table if provided
    // Note: We sync even if groups array is empty to handle deletion of all groups
    if (groups && Array.isArray(groups)) {
      // Create a map of node positions for classes
      const nodePositions: Record<string, { x: number; y: number }> = {};
      if (nodes && Array.isArray(nodes)) {
        nodes.forEach((node: any) => {
          if (node.id && node.position && node.type !== 'groupNode') {
            nodePositions[node.id] = { x: node.position.x, y: node.position.y };
          }
        });
      }
      await syncGroupsForVersion(versionId, groups, nodePositions);
    }

    if (existingResult.rowCount > 0) {
      // Update existing default layout (groups stored in separate table)
      return updateCanvasLayout(existingResult.rows[0].id, {
        viewport,
        nodes,
        edges: edges || []
      });
    } else {
      // Create new default layout (groups stored in separate table)
      return createCanvasLayout(
        versionId,
        userId,
        'Default',
        true,
        viewport,
        nodes,
        edges || [],
        null,
        { enabled: true, size: 20, snapToGrid: true, showGrid: true },
        { enabled: true, position: 'bottom-right', size: 'medium' },
        {}
      );
    }
  } catch (error: any) {
    console.error('Error saving default canvas layout:', error);
    return errorResponse(error.message);
  }
}

// ============================================================================
// CANVAS NOTES (#2394 DUX-2.1)
// Sticky notes / callouts persist as `noteNode` entries inside the default
// canvas layout's `nodes` JSON payload. These helpers read and merge them so
// exports can embed x-apiome-note / x-apiome-canvas extensions and imports can
// restore annotations.
// ============================================================================

/** React Flow node type used for canvas notes in layout payloads. */
const CANVAS_NOTE_NODE_TYPE = 'noteNode';

/** One note as stored in the layout payload / returned to the studio. */
type CanvasNoteRow = {
  id: string;
  kind: 'sticky' | 'callout';
  text: string;
  color: string;
  position: { x: number; y: number };
  dimensions?: { width: number; height: number };
  attachedToClassId?: string | null;
};

/** Extracts and sanitizes noteNode entries from a layout `nodes` payload. */
function extractCanvasNotesFromLayoutNodes(nodesPayload: unknown): CanvasNoteRow[] {
  const nodes = Array.isArray(nodesPayload) ? nodesPayload : [];
  const notes: CanvasNoteRow[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as any;
    if (n.type !== CANVAS_NOTE_NODE_TYPE || typeof n.id !== 'string' || !n.id) continue;
    const data = n.data && typeof n.data === 'object' ? n.data : {};
    const x = typeof n.position?.x === 'number' && Number.isFinite(n.position.x) ? n.position.x : 0;
    const y = typeof n.position?.y === 'number' && Number.isFinite(n.position.y) ? n.position.y : 0;
    const width = typeof n.dimensions?.width === 'number' && n.dimensions.width > 0 ? n.dimensions.width : undefined;
    const height = typeof n.dimensions?.height === 'number' && n.dimensions.height > 0 ? n.dimensions.height : undefined;
    notes.push({
      id: n.id,
      kind: data.kind === 'callout' ? 'callout' : 'sticky',
      text: typeof data.text === 'string' ? data.text : '',
      color: typeof data.color === 'string' && data.color ? data.color : 'amber',
      position: { x, y },
      ...(width !== undefined && height !== undefined ? { dimensions: { width, height } } : {}),
      attachedToClassId:
        typeof data.attachedToClassId === 'string' && data.attachedToClassId
          ? data.attachedToClassId
          : null,
    });
  }
  return notes;
}

/** Maps a note row to a layout `nodes` entry (mapNodesForLayoutSave shape). */
function canvasNoteToLayoutNode(note: CanvasNoteRow) {
  return {
    id: note.id,
    type: CANVAS_NOTE_NODE_TYPE,
    position: note.position,
    ...(note.dimensions ? { dimensions: note.dimensions } : {}),
    data: {
      kind: note.kind,
      text: note.text,
      color: note.color,
      attachedToClassId: note.attachedToClassId ?? null,
    },
  };
}

/**
 * Reads canvas notes for a version from its default canvas layout
 * (user-specific default first, then the shared default).
 *
 * @returns JSON `{ success, notes: CanvasNoteRow[] }`
 */
export async function getCanvasNotesForVersion(versionId: string, userId?: string) {
  try {
    const layoutRes = JSON.parse(await getDefaultCanvasLayout(versionId, userId));
    if (!layoutRes.success) {
      return errorResponse(layoutRes.error || 'Failed to load default canvas layout');
    }
    const notes = layoutRes.layout ? extractCanvasNotesFromLayoutNodes(layoutRes.layout.nodes) : [];
    return successResponse({ notes });
  } catch (error: any) {
    console.error('Error fetching canvas notes for version:', error);
    return errorResponse(error.message);
  }
}

/**
 * Restores imported canvas annotations (from x-apiome-note / x-apiome-canvas
 * extensions) into the version's default canvas layout.
 *
 * Notes attached by class NAME are re-linked to the class ID in this version;
 * names that do not resolve import as freeform notes so nothing is dropped.
 * Existing notes with the same ID are replaced; imported IDs are kept so a
 * re-import stays idempotent.
 *
 * @param notes Array of `{ id, kind, text, color, position, dimensions?, attachedTo? }`
 * @returns JSON `{ success, restored }`
 */
export async function saveImportedCanvasNotes(
  versionId: string,
  userId: string | null,
  notes: unknown[]
) {
  try {
    if (!Array.isArray(notes) || notes.length === 0) {
      return successResponse({ restored: 0 });
    }

    const classRows = await connectionPool.query(
      `SELECT id, name FROM apiome.classes WHERE version_id = $1 AND deleted_at IS NULL`,
      [versionId]
    );
    const classIdByName = new Map<string, string>(
      classRows.rows.map((r: { id: string; name: string }) => [r.name, r.id])
    );

    const noteRows: CanvasNoteRow[] = [];
    for (const raw of notes) {
      if (!raw || typeof raw !== 'object') continue;
      const n = raw as any;
      if (typeof n.id !== 'string' || !n.id) continue;
      const x = typeof n.position?.x === 'number' && Number.isFinite(n.position.x) ? n.position.x : 0;
      const y = typeof n.position?.y === 'number' && Number.isFinite(n.position.y) ? n.position.y : 0;
      const width = typeof n.dimensions?.width === 'number' && n.dimensions.width > 0 ? n.dimensions.width : undefined;
      const height = typeof n.dimensions?.height === 'number' && n.dimensions.height > 0 ? n.dimensions.height : undefined;
      const attachedName = typeof n.attachedTo === 'string' ? n.attachedTo : null;
      noteRows.push({
        id: n.id,
        kind: n.kind === 'callout' ? 'callout' : 'sticky',
        text: typeof n.text === 'string' ? n.text : '',
        color: typeof n.color === 'string' && n.color ? n.color : 'amber',
        position: { x, y },
        ...(width !== undefined && height !== undefined ? { dimensions: { width, height } } : {}),
        attachedToClassId: attachedName ? (classIdByName.get(attachedName) ?? null) : null,
      });
    }

    if (noteRows.length === 0) {
      return successResponse({ restored: 0 });
    }

    const layoutRes = JSON.parse(await getDefaultCanvasLayout(versionId, userId ?? undefined));
    const existingLayout = layoutRes.success ? layoutRes.layout : null;

    const importedIds = new Set(noteRows.map((n) => n.id));
    const noteLayoutNodes = noteRows.map(canvasNoteToLayoutNode);

    if (existingLayout) {
      const currentNodes = Array.isArray(existingLayout.nodes) ? existingLayout.nodes : [];
      const keptNodes = currentNodes.filter(
        (n: any) => !(n && n.type === CANVAS_NOTE_NODE_TYPE && importedIds.has(n.id))
      );
      const updateRes = JSON.parse(
        await updateCanvasLayout(existingLayout.id, {
          nodes: [...keptNodes, ...noteLayoutNodes],
        })
      );
      if (!updateRes.success) {
        return errorResponse(updateRes.error || 'Failed to update default canvas layout');
      }
    } else {
      const createRes = JSON.parse(
        await createCanvasLayout(
          versionId,
          userId,
          'Default',
          true,
          { x: 0, y: 0, zoom: 1 },
          noteLayoutNodes,
          [],
          null,
          { enabled: true, size: 20, snapToGrid: true, showGrid: true },
          { enabled: true, position: 'bottom-right', size: 'medium' },
          {}
        )
      );
      if (!createRes.success) {
        return errorResponse(createRes.error || 'Failed to create default canvas layout');
      }
    }

    return successResponse({ restored: noteRows.length });
  } catch (error: any) {
    console.error('Error restoring imported canvas notes:', error);
    return errorResponse(error.message);
  }
}

// ============================================================================
// GROUPS MANAGEMENT
// Functions for managing canvas groups stored in dedicated tables
// ============================================================================

/**
 * Get all groups for a version with their member classes
 */
export async function getGroupsForVersion(versionId: string) {
  try {
    // Get all groups for the version
    const groupsResult = await connectionPool.query(
      `SELECT g.id, g.version_id, g.name, g.description, g.color,
              g.position_x, g.position_y, g.width, g.height, g.z_index,
              g.is_collapsed, g.is_locked, g.opacity, g.border_style, g.metadata,
              g.parent_group_id,
              g.created_at, g.updated_at
       FROM apiome.groups g
       WHERE g.version_id = $1
       ORDER BY g.z_index, g.created_at`,
      [versionId]
    );

    // Get member classes for each group
    const groups = await Promise.all(groupsResult.rows.map(async (group: any) => {
      const classesResult = await connectionPool.query(
        `SELECT gc.class_id, gc.position_x, gc.position_y, gc.sort_order
         FROM apiome.group_classes gc
         WHERE gc.group_id = $1
         ORDER BY gc.sort_order`,
        [group.id]
      );

      // Create a map of class positions for easy lookup
      const classPositions: Record<string, { x: number | null; y: number | null }> = {};
      classesResult.rows.forEach((c: any) => {
        classPositions[c.class_id] = { x: c.position_x, y: c.position_y };
      });

      return {
        id: group.id,
        versionId: group.version_id,
        name: group.name,
        description: group.description,
        color: group.color,
        position: { x: group.position_x, y: group.position_y },
        dimensions: { width: group.width, height: group.height },
        zIndex: group.z_index,
        isCollapsed: group.is_collapsed,
        isLocked: group.is_locked,
        opacity: group.opacity,
        borderStyle: group.border_style,
        metadata: group.metadata,
        parentId: group.parent_group_id ?? null,
        nodeIds: classesResult.rows.map((c: any) => c.class_id),
        classPositions: classPositions,
        createdAt: group.created_at,
        updatedAt: group.updated_at
      };
    }));

    return JSON.stringify(groups);
  } catch (error: any) {
    console.error('Error fetching groups for version:', error);
    return JSON.stringify([]);
  }
}

/**
 * Create a new group for a version
 */
export async function createGroup(
  versionId: string,
  name: string,
  options: {
    description?: string;
    color?: string;
    position?: { x: number; y: number };
    dimensions?: { width: number; height: number };
    zIndex?: number;
    opacity?: number;
    borderStyle?: string;
    metadata?: any;
  } = {}
) {
  try {
    const {
      description = null,
      color = '#3B82F6',
      position = { x: 0, y: 0 },
      dimensions = { width: 200, height: 200 },
      zIndex = 0,
      opacity = 1.0,
      borderStyle = 'dashed',
      metadata = {}
    } = options;

    const result = await connectionPool.query(
      `INSERT INTO apiome.groups 
       (version_id, name, description, color, position_x, position_y, width, height, z_index, opacity, border_style, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, version_id, name, description, color, position_x, position_y, width, height, 
                 z_index, is_collapsed, is_locked, opacity, border_style, metadata, created_at, updated_at`,
      [versionId, name, description, color, position.x, position.y, dimensions.width, dimensions.height,
       zIndex, opacity, borderStyle, JSON.stringify(metadata)]
    );

    const group = result.rows[0];
    return successResponse({
      group: {
        id: group.id,
        versionId: group.version_id,
        name: group.name,
        description: group.description,
        color: group.color,
        position: { x: group.position_x, y: group.position_y },
        dimensions: { width: group.width, height: group.height },
        zIndex: group.z_index,
        isCollapsed: group.is_collapsed,
        isLocked: group.is_locked,
        opacity: group.opacity,
        borderStyle: group.border_style,
        metadata: group.metadata,
        nodeIds: [],
        createdAt: group.created_at,
        updatedAt: group.updated_at
      }
    });
  } catch (error: any) {
    console.error('Error creating group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Update an existing group
 */
export async function updateGroup(
  groupId: string,
  updates: {
    name?: string;
    description?: string;
    color?: string;
    position?: { x: number; y: number };
    dimensions?: { width: number; height: number };
    zIndex?: number;
    isCollapsed?: boolean;
    isLocked?: boolean;
    opacity?: number;
    borderStyle?: string;
    metadata?: any;
    /** Set null to make the group top-level (#155). */
    parentGroupId?: string | null;
  }
) {
  try {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.color !== undefined) {
      setClauses.push(`color = $${paramIndex++}`);
      values.push(updates.color);
    }
    if (updates.position !== undefined) {
      setClauses.push(`position_x = $${paramIndex++}`);
      values.push(updates.position.x);
      setClauses.push(`position_y = $${paramIndex++}`);
      values.push(updates.position.y);
    }
    if (updates.dimensions !== undefined) {
      setClauses.push(`width = $${paramIndex++}`);
      values.push(updates.dimensions.width);
      setClauses.push(`height = $${paramIndex++}`);
      values.push(updates.dimensions.height);
    }
    if (updates.zIndex !== undefined) {
      setClauses.push(`z_index = $${paramIndex++}`);
      values.push(updates.zIndex);
    }
    if (updates.isCollapsed !== undefined) {
      setClauses.push(`is_collapsed = $${paramIndex++}`);
      values.push(updates.isCollapsed);
    }
    if (updates.isLocked !== undefined) {
      setClauses.push(`is_locked = $${paramIndex++}`);
      values.push(updates.isLocked);
    }
    if (updates.opacity !== undefined) {
      setClauses.push(`opacity = $${paramIndex++}`);
      values.push(updates.opacity);
    }
    if (updates.borderStyle !== undefined) {
      setClauses.push(`border_style = $${paramIndex++}`);
      values.push(updates.borderStyle);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }
    if (updates.parentGroupId !== undefined) {
      setClauses.push(`parent_group_id = $${paramIndex++}`);
      values.push(updates.parentGroupId);
    }

    if (setClauses.length === 0) {
      return errorResponse('No updates provided');
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`);
    values.push(groupId);

    const result = await connectionPool.query(
      `UPDATE apiome.groups SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rowCount === 0) {
      return errorResponse('Group not found');
    }

    return successResponse({ group: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Delete a group
 */
export async function deleteGroup(groupId: string) {
  try {
    const result = await connectionPool.query(
      `DELETE FROM apiome.groups WHERE id = $1 RETURNING id`,
      [groupId]
    );

    if (result.rowCount === 0) {
      return errorResponse('Group not found');
    }

    return successResponse({ deleted: true });
  } catch (error: any) {
    console.error('Error deleting group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Add a class to a group
 */
export async function addClassToGroup(
  groupId: string,
  classId: string,
  options: { positionX?: number; positionY?: number; sortOrder?: number } = {}
) {
  try {
    const { positionX = null, positionY = null, sortOrder = 0 } = options;

    const result = await connectionPool.query(
      `INSERT INTO apiome.group_classes (group_id, class_id, position_x, position_y, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, class_id) DO UPDATE SET
         position_x = EXCLUDED.position_x,
         position_y = EXCLUDED.position_y,
         sort_order = EXCLUDED.sort_order
       RETURNING *`,
      [groupId, classId, positionX, positionY, sortOrder]
    );

    return successResponse({ groupClass: result.rows[0] });
  } catch (error: any) {
    console.error('Error adding class to group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Remove a class from a group
 */
export async function removeClassFromGroup(groupId: string, classId: string) {
  try {
    const result = await connectionPool.query(
      `DELETE FROM apiome.group_classes WHERE group_id = $1 AND class_id = $2 RETURNING id`,
      [groupId, classId]
    );

    if (result.rowCount === 0) {
      return errorResponse('Class not found in group');
    }

    return successResponse({ removed: true });
  } catch (error: any) {
    console.error('Error removing class from group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Update a class position within a group
 */
export async function updateClassPositionInGroup(
  groupId: string,
  classId: string,
  positionX: number,
  positionY: number
) {
  try {
    const result = await connectionPool.query(
      `UPDATE apiome.group_classes 
       SET position_x = $3, position_y = $4
       WHERE group_id = $1 AND class_id = $2
       RETURNING *`,
      [groupId, classId, positionX, positionY]
    );

    if (result.rowCount === 0) {
      return errorResponse('Class not found in group');
    }

    return successResponse({ groupClass: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating class position in group:', error);
    return errorResponse(error.message);
  }
}

/**
 * Sync all groups for a version (used when saving canvas state)
 * This replaces all groups for a version with the provided groups
 */
export async function syncGroupsForVersion(versionId: string, groups: any[], nodePositions?: Record<string, { x: number; y: number }>) {
  try {
    // Start a transaction
    await connectionPool.query('BEGIN');

    // Delete all existing groups for this version (cascades to group_classes)
    await connectionPool.query(
      `DELETE FROM apiome.groups WHERE version_id = $1`,
      [versionId]
    );

    // Track mapping from client ID to database ID for returning
    const idMapping: Record<string, string> = {};

    const sortedGroups = sortGroupsParentsBeforeChildren(groups);

    // Insert new groups (parents before children so parent_group_id resolves)
    for (const group of sortedGroups) {
      const position = group.position || { x: 0, y: 0 };
      const dimensions = group.dimensions || { width: 200, height: 200 };

      const parentClientId = group.parentId || null;
      let parentDbId: string | null = null;
      if (parentClientId) {
        parentDbId = idMapping[parentClientId] || null;
        if (!parentDbId) {
          await connectionPool.query('ROLLBACK');
          return errorResponse(
            `Sync: parent group id ${parentClientId} not found or out of order for child ${group.id || group.name}`
          );
        }
      }

      const isCollapsed = group.isCollapsed === true;

      // Let database generate UUID - don't use client-side ID
      const groupResult = await connectionPool.query(
        `INSERT INTO apiome.groups 
         (version_id, name, description, color, position_x, position_y, width, height, 
          z_index, opacity, border_style, metadata, parent_group_id, is_collapsed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          versionId,
          group.name || 'Untitled Group',
          group.description || null,
          group.color || '#3B82F6',
          position.x,
          position.y,
          dimensions.width,
          dimensions.height,
          group.zIndex || 0,
          group.opacity ?? 1.0,
          group.borderStyle || group.styleOptions?.borderStyle || 'dashed',
          JSON.stringify(buildGroupMetadataForSync(group as Record<string, unknown>)),
          parentDbId,
          isCollapsed
        ]
      );

      const newGroupId = groupResult.rows[0].id;
      idMapping[group.id] = newGroupId;

      // Insert group classes with positions
      const nodeIds = group.nodeIds || [];
      for (let i = 0; i < nodeIds.length; i++) {
        const nodeId = nodeIds[i];
        const nodePos = nodePositions?.[nodeId] || null;

        await connectionPool.query(
          `INSERT INTO apiome.group_classes (group_id, class_id, position_x, position_y, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (group_id, class_id) DO UPDATE SET
             position_x = EXCLUDED.position_x,
             position_y = EXCLUDED.position_y,
             sort_order = EXCLUDED.sort_order`,
          [newGroupId, nodeId, nodePos?.x ?? null, nodePos?.y ?? null, i]
        );
      }
    }

    await connectionPool.query('COMMIT');
    return successResponse({ synced: true, count: groups.length, idMapping });
  } catch (error: any) {
    await connectionPool.query('ROLLBACK');
    console.error('Error syncing groups for version:', error);
    return errorResponse(error.message);
  }
}

/* ==========================================
 * PRIMITIVES MANAGEMENT
 * ========================================== */

export interface Primitive {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  category: string;
  schema: any;
  tags: string[];
  created_by: string | null;
  is_system: boolean;
  is_public: boolean;
  usage_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Get all primitives for a tenant
 */
export async function getPrimitives(tenantId: string, category?: string | null) {
  try {
    let query = `
      SELECT id, tenant_id, name, description, category, schema, tags, created_by,
             is_system, is_public, usage_count, enabled, created_at, updated_at
      FROM apiome.primitives
      WHERE tenant_id = $1 AND deleted_at IS NULL AND enabled = true
    `;

    const params: any[] = [tenantId];

    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }

    query += ' ORDER BY category, name';

    const result = await connectionPool.query(query, params);
    return JSON.stringify({ success: true, primitives: result.rows });
  } catch (error: any) {
    console.error('Error fetching primitives:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Get primitive categories for a tenant
 */
export async function getPrimitiveCategories(tenantId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT category, COUNT(*) as count
       FROM apiome.primitives
       WHERE tenant_id = $1 AND deleted_at IS NULL AND enabled = true
       GROUP BY category
       ORDER BY category`,
      [tenantId]
    );
    return JSON.stringify({ success: true, categories: result.rows });
  } catch (error: any) {
    console.error('Error fetching primitive categories:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Get a specific primitive by ID
 */
export async function getPrimitiveById(primitiveId: string, tenantId: string) {
  try {
    const result = await connectionPool.query(
      `SELECT id, tenant_id, name, description, category, schema, tags, created_by,
              is_system, is_public, usage_count, enabled, created_at, updated_at
       FROM apiome.primitives
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [primitiveId, tenantId]
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Primitive not found' });
    }

    return JSON.stringify({ success: true, primitive: result.rows[0] });
  } catch (error: any) {
    console.error('Error fetching primitive:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Create a new primitive
 */
export async function createPrimitive(
  tenantId: string,
  createdBy: string,
  name: string,
  description: string | null,
  category: string,
  schema: any,
  tags: string[] = []
) {
  try {
    if (!name || name.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Primitive name is required' });
    }

    if (!category || category.trim().length === 0) {
      return JSON.stringify({ success: false, error: 'Category is required' });
    }

    if (!schema) {
      return JSON.stringify({ success: false, error: 'Schema is required' });
    }

    const result = await connectionPool.query(
      `INSERT INTO apiome.primitives 
       (tenant_id, created_by, name, description, category, schema, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, name, description, category, schema, tags, created_by,
                 is_system, is_public, usage_count, enabled, created_at, updated_at`,
      [tenantId, createdBy, name.trim(), description, category.trim(), JSON.stringify(schema), tags]
    );

    return JSON.stringify({ success: true, primitive: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating primitive:', error);

    if (error.code === '23505') {
      return JSON.stringify({
        success: false,
        error: `A type named "${name}" already exists in that namespace. Names are unique per namespace.`
      });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Update a primitive
 */
export async function updatePrimitive(
  primitiveId: string,
  tenantId: string,
  updates: {
    name?: string;
    description?: string;
    category?: string;
    schema?: any;
    tags?: string[];
    enabled?: boolean;
  }
) {
  try {
    // Check if primitive exists and is updatable
    const existing = await connectionPool.query(
      `SELECT is_system, tenant_id FROM apiome.primitives WHERE id = $1 AND deleted_at IS NULL`,
      [primitiveId]
    );

    if (existing.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Primitive not found' });
    }

    if (existing.rows[0].is_system) {
      return JSON.stringify({ success: false, error: 'System primitives cannot be updated' });
    }

    if (existing.rows[0].tenant_id !== tenantId) {
      return JSON.stringify({ success: false, error: 'You can only update primitives owned by your tenant' });
    }

    const updateFields = [];
    const params: any[] = [];
    let paramCount = 1;

    if (updates.name !== undefined) {
      updateFields.push(`name = $${paramCount}`);
      params.push(updates.name);
      paramCount++;
    }

    if (updates.description !== undefined) {
      updateFields.push(`description = $${paramCount}`);
      params.push(updates.description);
      paramCount++;
    }

    if (updates.category !== undefined) {
      updateFields.push(`category = $${paramCount}`);
      params.push(updates.category);
      paramCount++;
    }

    if (updates.schema !== undefined) {
      updateFields.push(`schema = $${paramCount}`);
      params.push(JSON.stringify(updates.schema));
      paramCount++;
    }

    if (updates.tags !== undefined) {
      updateFields.push(`tags = $${paramCount}`);
      params.push(updates.tags);
      paramCount++;
    }

    if (updates.enabled !== undefined) {
      updateFields.push(`enabled = $${paramCount}`);
      params.push(updates.enabled);
      paramCount++;
    }

    if (updateFields.length === 0) {
      return JSON.stringify({ success: false, error: 'No fields to update' });
    }

    params.push(primitiveId);
    params.push(tenantId);

    const result = await connectionPool.query(
      `UPDATE apiome.primitives
       SET ${updateFields.join(', ')}
       WHERE id = $${paramCount} AND tenant_id = $${paramCount + 1} AND deleted_at IS NULL
       RETURNING id, tenant_id, name, description, category, schema, tags, created_by,
                 is_system, is_public, usage_count, enabled, created_at, updated_at`,
      params
    );

    if (result.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Primitive not found or update failed' });
    }

    return JSON.stringify({ success: true, primitive: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating primitive:', error);

    if (error.code === '23505') {
      return JSON.stringify({
        success: false,
        error: 'A type with that name already exists in this namespace'
      });
    }

    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Delete a primitive (soft delete)
 */
export async function deletePrimitive(primitiveId: string, tenantId: string) {
  try {
    // Check if primitive exists and is deletable
    const existing = await connectionPool.query(
      `SELECT is_system, tenant_id FROM apiome.primitives WHERE id = $1 AND deleted_at IS NULL`,
      [primitiveId]
    );

    if (existing.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Primitive not found' });
    }

    if (existing.rows[0].is_system) {
      return JSON.stringify({ success: false, error: 'System primitives cannot be deleted' });
    }

    if (existing.rows[0].tenant_id !== tenantId) {
      return JSON.stringify({ success: false, error: 'You can only delete primitives owned by your tenant' });
    }

    await connectionPool.query(
      `UPDATE apiome.primitives SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [primitiveId]
    );

    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error deleting primitive:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Increment usage count when a primitive is used
 */
export async function incrementPrimitiveUsage(primitiveId: string) {
  try {
    await connectionPool.query(
      `UPDATE apiome.primitives SET usage_count = usage_count + 1 WHERE id = $1`,
      [primitiveId]
    );
    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('Error incrementing primitive usage:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/**
 * Import primitives from JSON Schema definitions
 */
export async function importPrimitivesFromSchema(
  tenantId: string,
  createdBy: string,
  jsonSchema: any,
  selectedDefinitions?: string[]
) {
  try {
    // Extract definitions from schema
    const definitions: Record<string, any> = {
      ...(jsonSchema.$defs || {}),
      ...(jsonSchema.definitions || {})
    };

    if (Object.keys(definitions).length === 0) {
      return JSON.stringify({
        success: false,
        error: 'No definitions found in JSON Schema. Schema must contain $defs or definitions.'
      });
    }

    // Filter if specific definitions requested
    let defsToImport = definitions;
    if (selectedDefinitions && selectedDefinitions.length > 0) {
      defsToImport = {};
      for (const key of selectedDefinitions) {
        if (definitions[key]) {
          defsToImport[key] = definitions[key];
        }
      }
    }

    const imported = [];
    const skipped = [];
    const errors = [];

    for (const [defName, defSchema] of Object.entries(defsToImport)) {
      try {
        // Determine category from schema type
        let schemaType = defSchema.type || 'object';
        if (Array.isArray(schemaType)) {
          schemaType = schemaType[0] || 'object';
        }

        const result = await connectionPool.query(
          `INSERT INTO apiome.primitives 
           (tenant_id, created_by, name, description, category, schema, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, name`,
          [
            tenantId,
            createdBy,
            defName,
            defSchema.description || null,
            schemaType,
            JSON.stringify(defSchema),
            defSchema.tags || []
          ]
        );

        imported.push(result.rows[0].name);
      } catch (error: any) {
        if (error.code === '23505') {
          skipped.push(defName);
        } else {
          errors.push({ name: defName, error: error.message });
        }
      }
    }

    return JSON.stringify({
      success: true,
      imported,
      skipped,
      errors,
      total_imported: imported.length,
      total_skipped: skipped.length,
      total_errors: errors.length
    });
  } catch (error: any) {
    console.error('Error importing primitives from schema:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export type BuildOpenApiSpecForVersionOptions = {
  projectName?: string | null;
  versionLabel?: string;
  description?: string | null;
  openapiVersion?: string;
  /**
   * Embed canvas sticky notes / callouts as x-apiome-note / x-apiome-canvas
   * extensions (#2394 DUX-2.1). Defaults to true; notes come from the
   * version's default canvas layout for the session user.
   */
  includeCanvasAnnotations?: boolean;
  metadata?: {
    summary?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name?: string; identifier?: string; url?: string };
  };
};

export type BuildOpenApiSpecForVersionResult = {
  specJson: string;
  pathsObject: Record<string, unknown>;
};

/**
 * Single source of truth for OpenAPI export by version: schemas, paths, servers, and security schemes.
 */
export async function buildOpenApiSpecForVersion(
  versionId: string,
  options: BuildOpenApiSpecForVersionOptions = {}
): Promise<BuildOpenApiSpecForVersionResult> {
  const classesRaw = await getClassesWithPropertiesAndTags(versionId);
  const classesWithProperties = JSON.parse(classesRaw);

  let pathsObject: Record<string, unknown> = {};
  try {
    const pathsResult = await loadPathsForOpenAPIExport(versionId);
    const pathsData = JSON.parse(pathsResult) as {
      success?: boolean;
      paths?: PathInfo[];
      error?: string;
    };
    if (pathsData.success && pathsData.paths && pathsData.paths.length > 0) {
      pathsObject = generatePathsForOpenAPI(pathsData.paths) as Record<string, unknown>;
    } else if (pathsData.success) {
      console.warn('[buildOpenApiSpecForVersion] Paths loaded successfully but array is empty');
    } else {
      console.error('[buildOpenApiSpecForVersion] Failed to load paths:', pathsData.error);
    }
  } catch (error) {
    console.error('[buildOpenApiSpecForVersion] Exception while loading paths:', error);
  }

  let securitySchemes: Record<string, unknown> = {};
  try {
    const schemes = await getSecuritySchemesForVersion(versionId);
    if (schemes.length > 0) {
      securitySchemes = (await securitySchemesToOpenAPI(schemes)) as Record<string, unknown>;
    }
  } catch (error) {
    console.error('[buildOpenApiSpecForVersion] Exception while loading security schemes:', error);
  }

  let servers: Array<{ url: string; description?: string }> = [];
  try {
    const serverList = await getServersForVersion(versionId);
    if (serverList.length > 0) {
      servers = await serversToOpenAPI(serverList);
    }
  } catch (error) {
    console.error('[buildOpenApiSpecForVersion] Exception while loading servers:', error);
  }

  // Canvas annotations (#2394): load notes from the default canvas layout and
  // re-key class attachments from IDs to names for portable export.
  let canvasAnnotations: Array<Record<string, unknown>> | undefined;
  if (options.includeCanvasAnnotations !== false) {
    try {
      const session = await getAuthSession();
      const sessionUserId = (session?.user as any)?.user_id as string | undefined;
      const notesRes = JSON.parse(await getCanvasNotesForVersion(versionId, sessionUserId));
      if (notesRes.success && Array.isArray(notesRes.notes) && notesRes.notes.length > 0) {
        const classNameById = new Map<string, string>(
          classesWithProperties.map((cls: { id: string; name: string }) => [cls.id, cls.name])
        );
        canvasAnnotations = notesRes.notes.map((note: any) => {
          const { attachedToClassId, ...rest } = note;
          const attachedTo = attachedToClassId ? classNameById.get(attachedToClassId) : undefined;
          return { ...rest, ...(attachedTo ? { attachedTo } : {}) };
        });
      }
    } catch (error) {
      console.error('[buildOpenApiSpecForVersion] Exception while loading canvas notes:', error);
    }
  }

  const hasSecuritySchemes = Object.keys(securitySchemes).length > 0;
  const specJson = await generateOpenApiSpec(
    classesWithProperties,
    {
      projectName: options.projectName ?? undefined,
      version: options.versionLabel ?? '1.0.0',
      description: options.description ?? undefined,
      openapiVersion: options.openapiVersion ?? STUDIO_EXPORT_OPENAPI_VERSION,
      servers: servers.length > 0 ? servers : undefined,
      tags: [],
      security: hasSecuritySchemes
        ? Object.keys(securitySchemes).map((name) => ({ [name]: [] }))
        : undefined,
      externalDocs: undefined,
      canvasAnnotations: canvasAnnotations as any,
      metadata: options.metadata,
    },
    pathsObject,
    hasSecuritySchemes ? securitySchemes : undefined
  );

  return { specJson, pathsObject };
}

export async function buildOpenApiSpecJsonForVersion(
  versionRow: {
    id: string;
    version_id: string;
    description?: string | null;
    shortMessage?: string | null;
    project_id: string;
  },
  projectName: string | null,
  metadata?: BuildOpenApiSpecForVersionOptions['metadata']
): Promise<string> {
  const { specJson } = await buildOpenApiSpecForVersion(versionRow.id, {
    projectName,
    versionLabel: versionRow.version_id,
    description: versionRow.shortMessage || versionRow.description || undefined,
    metadata,
  });
  return specJson;
}

export async function assertProjectInTenant(projectId: string, tenantId: string): Promise<boolean> {
  const r = await connectionPool.query(
    `SELECT 1 FROM apiome.projects p WHERE p.id = $1 AND p.tenant_id = $2 AND p.deleted_at IS NULL`,
    [projectId, tenantId]
  );
  return (r.rowCount ?? 0) > 0;
}

/** List named branches for a project (tips are version row ids). */
export async function listVersionBranches(projectId: string, tenantId: string) {
  try {
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const result = await connectionPool.query(
      `SELECT b.id, b.project_id, b.name, b.tip_version_id, b.is_default, b.protected, b.require_merge_path, b.created_by, b.created_at, b.updated_at,
              v.version_id AS tip_version_string
       FROM apiome.version_branches b
       JOIN apiome.versions v ON v.id = b.tip_version_id AND v.project_id = b.project_id
       JOIN apiome.projects p ON b.project_id = p.id
       WHERE b.project_id = $1 AND p.tenant_id = $2 AND v.deleted_at IS NULL
       ORDER BY b.name ASC`,
      [projectId, tenantId]
    );
    return JSON.stringify({ success: true, branches: result.rows });
  } catch (error: any) {
    console.error('listVersionBranches:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** Create a named branch whose tip is an existing version (revision). */
export async function createVersionBranch(
  projectId: string,
  tenantId: string,
  name: string,
  fromVersionId: string,
  userId: string
) {
  try {
    const trimmed = name.trim();
    if (!isValidVersionBranchName(trimmed)) {
      return JSON.stringify({
        success: false,
        error:
          'Branch name must start with a letter and contain only letters, digits, . _ - / (max 255 chars)',
      });
    }
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const ver = await connectionPool.query(
      `SELECT v.id, v.project_id FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       WHERE v.id = $1 AND v.project_id = $2 AND p.tenant_id = $3 AND v.deleted_at IS NULL`,
      [fromVersionId, projectId, tenantId]
    );
    if (ver.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Source version not found in this project' });
    }
    const ins = await connectionPool.query(
      `INSERT INTO apiome.version_branches (project_id, name, tip_version_id, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, project_id, name, tip_version_id, created_by, created_at, updated_at`,
      [projectId, trimmed, fromVersionId, userId]
    );
    return JSON.stringify({ success: true, branch: ins.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return JSON.stringify({ success: false, error: 'A branch with this name already exists for this project' });
    }
    console.error('createVersionBranch:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function deleteVersionBranch(
  branchId: string,
  projectId: string,
  tenantId: string,
  userId: string,
  isTenantAdmin: boolean
) {
  try {
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const row = await connectionPool.query(
      `SELECT b.id, b.created_by, b.protected, b.name, b.is_default FROM apiome.version_branches b
       JOIN apiome.projects p ON b.project_id = p.id
       WHERE b.id = $1 AND b.project_id = $2 AND p.tenant_id = $3`,
      [branchId, projectId, tenantId]
    );
    if (row.rowCount === 0) return JSON.stringify({ success: false, error: 'Branch not found' });
    const br = row.rows[0] as {
      created_by: string | null;
      protected: boolean;
      name: string;
      is_default?: boolean | null;
    };
    const nameNorm = String(br.name ?? '').trim().toLowerCase();
    if (br.is_default === true) {
      return JSON.stringify({
        success: false,
        error: 'The default branch cannot be deleted',
        code: 'BRANCH_DELETE_FORBIDDEN',
      });
    }
    if (nameNorm === 'main') {
      return JSON.stringify({
        success: false,
        error: 'The main branch cannot be deleted',
        code: 'BRANCH_DELETE_FORBIDDEN',
      });
    }
    if (br.protected && !isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'branch.delete',
        resourceType: 'version_branch',
        resourceId: branchId,
        outcome: 'denied',
        detail: { reason: 'branch_protected' },
      });
      return JSON.stringify({
        success: false,
        error: 'This branch is protected and cannot be deleted',
        code: 'BRANCH_PROTECTED',
      });
    }
    if (!isTenantAdmin && br.created_by !== userId) {
      return JSON.stringify({ success: false, error: 'Only the branch creator or a tenant admin can delete this branch' });
    }
    await connectionPool.query(`DELETE FROM apiome.version_branches WHERE id = $1`, [branchId]);
    if (br.protected && isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'branch.delete',
        resourceType: 'version_branch',
        resourceId: branchId,
        outcome: 'allowed',
        detail: { reason: 'admin_override_branch_protection' },
      });
    }
    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('deleteVersionBranch:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** Tenant admins only: set branch protection policy (Git-like branch protection). */
export async function updateVersionBranchProtection(
  branchId: string,
  projectId: string,
  tenantId: string,
  userId: string,
  isTenantAdmin: boolean,
  branchProtected?: boolean,
  requireMergePath?: boolean
) {
  try {
    if (!isTenantAdmin) {
      return JSON.stringify({
        success: false,
        error: 'Only tenant administrators can change branch protection',
        code: 'FORBIDDEN',
      });
    }
    const hasProtected = typeof branchProtected === 'boolean';
    const hasRequireMerge = typeof requireMergePath === 'boolean';
    if (!hasProtected && !hasRequireMerge) {
      return JSON.stringify({
        success: false,
        error: 'Provide protected and/or requireMergePath',
        code: 'INVALID_INPUT',
      });
    }
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    if (hasProtected) {
      sets.push(`protected = $${n++}`);
      params.push(branchProtected);
    }
    if (hasRequireMerge) {
      sets.push(`require_merge_path = $${n++}`);
      params.push(requireMergePath);
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    const whereStart = n;
    params.push(branchId, projectId, tenantId);
    const upd = await connectionPool.query(
      `UPDATE apiome.version_branches b SET ${sets.join(', ')}
       FROM apiome.projects p
       WHERE b.id = $${whereStart} AND b.project_id = $${whereStart + 1} AND b.project_id = p.id AND p.tenant_id = $${whereStart + 2}
       RETURNING b.id, b.project_id, b.name, b.tip_version_id, b.protected, b.require_merge_path, b.created_by, b.created_at, b.updated_at`,
      params
    );
    if (upd.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Branch not found' });
    }
    const auditDetail: Record<string, boolean> = {};
    if (hasProtected) auditDetail.protected = branchProtected as boolean;
    if (hasRequireMerge) auditDetail.requireMergePath = requireMergePath as boolean;
    await insertVersionProtectionAudit({
      tenantId,
      projectId,
      actorId: userId,
      action: 'branch.protection_policy',
      resourceType: 'version_branch',
      resourceId: branchId,
      outcome: 'policy_change',
      detail: auditDetail,
    });
    return JSON.stringify({ success: true, branch: upd.rows[0] });
  } catch (error: any) {
    console.error('updateVersionBranchProtection:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** Tenant admins only: lock or unlock a schema revision against soft-delete. */
export async function setVersionRevisionLock(
  versionRecordId: string,
  projectId: string,
  tenantId: string,
  userId: string,
  isTenantAdmin: boolean,
  revisionLocked: boolean
) {
  try {
    if (!isTenantAdmin) {
      return JSON.stringify({
        success: false,
        error: 'Only tenant administrators can lock or unlock revisions',
        code: 'FORBIDDEN',
      });
    }
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const upd = await connectionPool.query(
      `UPDATE apiome.versions v SET revision_locked = $1, updated_at = CURRENT_TIMESTAMP
       FROM apiome.projects p
       WHERE v.id = $2 AND v.project_id = $3 AND v.project_id = p.id AND p.tenant_id = $4 AND v.deleted_at IS NULL
       RETURNING v.id, v.project_id, v.version_id, v.revision_locked`,
      [revisionLocked, versionRecordId, projectId, tenantId]
    );
    if (upd.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Version not found' });
    }
    await insertVersionProtectionAudit({
      tenantId,
      projectId,
      actorId: userId,
      action: 'version.revision_lock',
      resourceType: 'version',
      resourceId: versionRecordId,
      outcome: 'policy_change',
      detail: { revision_locked: revisionLocked },
    });
    return JSON.stringify({ success: true, version: upd.rows[0] });
  } catch (error: any) {
    console.error('setVersionRevisionLock:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** List named tags for a project (pointers to version row ids). */
export async function listVersionTags(projectId: string, tenantId: string) {
  try {
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const result = await connectionPool.query(
      `SELECT t.id, t.project_id, t.version_id, t.name, t.message, t.channel, t.immutable, t.protected,
              t.created_by, t.created_at, t.updated_at, v.version_id AS target_version_string
       FROM apiome.version_tags t
       JOIN apiome.versions v ON v.id = t.version_id AND v.project_id = t.project_id
       JOIN apiome.projects p ON t.project_id = p.id
       WHERE t.project_id = $1 AND p.tenant_id = $2 AND v.deleted_at IS NULL
       ORDER BY t.name ASC`,
      [projectId, tenantId]
    );
    return JSON.stringify({ success: true, tags: result.rows });
  } catch (error: any) {
    console.error('listVersionTags:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

/** Create a tag pointing at an existing schema revision (version row). */
export async function createVersionTag(
  projectId: string,
  tenantId: string,
  name: string,
  targetVersionId: string,
  userId: string,
  opts?: { message?: string | null; channel?: string | null; immutable?: boolean; protected?: boolean },
  isTenantAdmin = false
) {
  try {
    const trimmed = name.trim();
    if (!isValidVersionTagName(trimmed)) {
      return JSON.stringify({
        success: false,
        error:
          'Tag name must be 1–255 chars, start with a letter or digit, and contain only letters, digits, . _ - /',
      });
    }
    const wantProtected = Boolean(opts?.protected);
    if (wantProtected && !isTenantAdmin) {
      return JSON.stringify({
        success: false,
        error: 'Only tenant administrators can create a protected tag',
        code: 'PROTECTED_TAG_ADMIN_ONLY',
      });
    }
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const ver = await connectionPool.query(
      `SELECT v.id FROM apiome.versions v
       JOIN apiome.projects p ON v.project_id = p.id
       WHERE v.id = $1 AND v.project_id = $2 AND p.tenant_id = $3 AND v.deleted_at IS NULL`,
      [targetVersionId, projectId, tenantId]
    );
    if (ver.rowCount === 0) {
      return JSON.stringify({ success: false, error: 'Target version not found in this project' });
    }
    const message = opts?.message?.trim() || null;
    const channel =
      opts?.channel && String(opts.channel).trim() ? String(opts.channel).trim().slice(0, 64) : null;
    const immutable = Boolean(opts?.immutable);
    const ins = await connectionPool.query(
      `INSERT INTO apiome.version_tags (project_id, version_id, name, message, channel, immutable, protected, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, project_id, version_id, name, message, channel, immutable, protected, created_by, created_at, updated_at`,
      [projectId, targetVersionId, trimmed, message, channel, immutable, wantProtected, userId]
    );
    return JSON.stringify({ success: true, tag: ins.rows[0] });
  } catch (error: any) {
    if (error.code === '23505') {
      return JSON.stringify({
        success: false,
        error: 'A tag with this name already exists for this project',
        code: 'TAG_NAME_CONFLICT',
      });
    }
    console.error('createVersionTag:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function updateVersionTag(
  tagId: string,
  projectId: string,
  tenantId: string,
  userId: string,
  isTenantAdmin: boolean,
  body: { versionId?: string; immutable?: boolean; protected?: boolean }
) {
  try {
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const row = await connectionPool.query(
      `SELECT t.id, t.version_id, t.immutable, t.protected, t.created_by
       FROM apiome.version_tags t
       JOIN apiome.projects p ON t.project_id = p.id
       WHERE t.id = $1 AND t.project_id = $2 AND p.tenant_id = $3`,
      [tagId, projectId, tenantId]
    );
    if (row.rowCount === 0) return JSON.stringify({ success: false, error: 'Tag not found' });
    const tag = row.rows[0] as {
      id: string;
      version_id: string;
      immutable: boolean;
      protected: boolean;
      created_by: string | null;
    };
    if (tag.immutable) {
      return JSON.stringify({
        success: false,
        error: 'This tag is immutable and cannot be changed',
        code: 'TAG_IMMUTABLE',
      });
    }
    if (body.protected !== undefined && !isTenantAdmin) {
      return JSON.stringify({
        success: false,
        error: 'Only tenant administrators can change tag protection policy',
        code: 'TAG_PROTECT_POLICY_ADMIN_ONLY',
      });
    }
    if (tag.protected && !isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'tag.update',
        resourceType: 'version_tag',
        resourceId: tagId,
        outcome: 'denied',
        detail: { reason: 'tag_protected' },
      });
      return JSON.stringify({
        success: false,
        error: 'This tag is protected: only tenant admins may move it or change policy',
        code: 'TAG_PROTECTED',
      });
    }
    if (!isTenantAdmin && tag.created_by !== userId) {
      return JSON.stringify({
        success: false,
        error: 'Only the tag creator or a tenant admin can update this tag',
      });
    }
    const newVersionId = typeof body.versionId === 'string' ? body.versionId.trim() : '';
    const wantImmutable = body.immutable === true;
    const policyProtected =
      typeof body.protected === 'boolean' ? body.protected : undefined;
    if (newVersionId) {
      const ver = await connectionPool.query(
        `SELECT v.id FROM apiome.versions v
         JOIN apiome.projects p ON v.project_id = p.id
         WHERE v.id = $1 AND v.project_id = $2 AND p.tenant_id = $3 AND v.deleted_at IS NULL`,
        [newVersionId, projectId, tenantId]
      );
      if (ver.rowCount === 0) {
        return JSON.stringify({ success: false, error: 'Target version not found in this project' });
      }
    }
    if (!newVersionId && !wantImmutable && policyProtected === undefined) {
      return JSON.stringify({
        success: false,
        error: 'Provide versionId, immutable: true, and/or protected (admin only)',
      });
    }
    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    if (newVersionId) {
      params.push(newVersionId);
      sets.push(`version_id = $${params.length}`);
    }
    if (wantImmutable) {
      sets.push('immutable = true');
    }
    if (policyProtected !== undefined) {
      params.push(policyProtected);
      sets.push(`protected = $${params.length}`);
    }
    params.push(tagId, projectId);
    const idSlot = params.length - 1;
    const projSlot = params.length;
    const upd = await connectionPool.query(
      `UPDATE apiome.version_tags SET ${sets.join(', ')}
       WHERE id = $${idSlot} AND project_id = $${projSlot}
       RETURNING id, project_id, version_id, name, message, channel, immutable, protected, created_by, created_at, updated_at`,
      params
    );
    if (tag.protected && isTenantAdmin && (newVersionId || wantImmutable)) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'tag.update',
        resourceType: 'version_tag',
        resourceId: tagId,
        outcome: 'allowed',
        detail: { reason: 'admin_override_tag_protection' },
      });
    }
    if (policyProtected !== undefined) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'tag.protection_policy',
        resourceType: 'version_tag',
        resourceId: tagId,
        outcome: 'policy_change',
        detail: { protected: policyProtected },
      });
    }
    return JSON.stringify({ success: true, tag: upd.rows[0] });
  } catch (error: any) {
    console.error('updateVersionTag:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

export async function deleteVersionTag(
  tagId: string,
  projectId: string,
  tenantId: string,
  userId: string,
  isTenantAdmin: boolean
) {
  try {
    const ok = await assertProjectInTenant(projectId, tenantId);
    if (!ok) return JSON.stringify({ success: false, error: 'Project not found' });
    const row = await connectionPool.query(
      `SELECT t.id, t.immutable, t.protected, t.created_by FROM apiome.version_tags t
       JOIN apiome.projects p ON t.project_id = p.id
       WHERE t.id = $1 AND t.project_id = $2 AND p.tenant_id = $3`,
      [tagId, projectId, tenantId]
    );
    if (row.rowCount === 0) return JSON.stringify({ success: false, error: 'Tag not found' });
    const tag = row.rows[0] as { immutable: boolean; protected: boolean; created_by: string | null };
    if (tag.immutable) {
      return JSON.stringify({
        success: false,
        error: 'This tag is immutable and cannot be deleted',
        code: 'TAG_IMMUTABLE',
      });
    }
    if (tag.protected && !isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'tag.delete',
        resourceType: 'version_tag',
        resourceId: tagId,
        outcome: 'denied',
        detail: { reason: 'tag_protected' },
      });
      return JSON.stringify({
        success: false,
        error: 'This tag is protected and cannot be deleted',
        code: 'TAG_PROTECTED',
      });
    }
    if (!isTenantAdmin && tag.created_by !== userId) {
      return JSON.stringify({
        success: false,
        error: 'Only the tag creator or a tenant admin can delete this tag',
      });
    }
    await connectionPool.query(`DELETE FROM apiome.version_tags WHERE id = $1`, [tagId]);
    if (tag.protected && isTenantAdmin) {
      await insertVersionProtectionAudit({
        tenantId,
        projectId,
        actorId: userId,
        action: 'tag.delete',
        resourceType: 'version_tag',
        resourceId: tagId,
        outcome: 'allowed',
        detail: { reason: 'admin_override_tag_protection' },
      });
    }
    return JSON.stringify({ success: true });
  } catch (error: any) {
    console.error('deleteVersionTag:', error);
    return JSON.stringify({ success: false, error: error.message });
  }
}

async function copySingleClassBetweenVersions(
  sourceVersionId: string,
  targetVersionId: string,
  className: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await connectionPool.query(
      `INSERT INTO apiome.classes (version_id, name, description, schema, enabled, canvas_metadata)
       SELECT $1, name, description, schema, enabled, canvas_metadata
       FROM apiome.classes
       WHERE version_id = $2 AND name = $3 AND deleted_at IS NULL
       RETURNING id, name`,
      [targetVersionId, sourceVersionId, className]
    );
    if (result.rowCount === 0) {
      return { success: false, error: `Class ${className} not found on source version` };
    }
    const copiedClass = result.rows[0];
    const originalClassResult = await connectionPool.query(
      `SELECT id FROM apiome.classes
       WHERE version_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [sourceVersionId, copiedClass.name]
    );
    if (originalClassResult.rowCount === 0) {
      return { success: false, error: 'Original class missing' };
    }
    const originalClassId = originalClassResult.rows[0].id;
    const newClassId = copiedClass.id;
    const originalPropertiesResult = await connectionPool.query(
      `SELECT id, property_id, name, description, data, parent_id
       FROM apiome.class_properties
       WHERE class_id = $1`,
      [originalClassId]
    );
    const oldToNewIdMap = new Map<string, string>();
    const allProperties = originalPropertiesResult.rows;
    const processedIds = new Set<string>();

    const copyPropertiesRecursively = async (parentId: string | null) => {
      const propsAtThisLevel = allProperties.filter(
        (p: any) =>
          (p.parent_id === parentId || (p.parent_id === null && parentId === null)) && !processedIds.has(p.id)
      );
      for (const prop of propsAtThisLevel) {
        const newParentId = prop.parent_id ? oldToNewIdMap.get(prop.parent_id) || null : null;
        const insertResult = await connectionPool.query(
          `INSERT INTO apiome.class_properties (class_id, property_id, name, description, data, parent_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [newClassId, prop.property_id, prop.name, prop.description, prop.data, newParentId]
        );
        const newId = insertResult.rows[0].id;
        oldToNewIdMap.set(prop.id, newId);
        processedIds.add(prop.id);
        await copyPropertiesRecursively(prop.id);
      }
    };
    await copyPropertiesRecursively(null);
    return { success: true };
  } catch (error: any) {
    console.error('copySingleClassBetweenVersions:', error);
    return { success: false, error: error.message };
  }
}

