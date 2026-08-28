/**
 * Shared plumbing for the version mock proxy routes (#5529, MSC-1.3).
 *
 * Every `/api/versions/{id}/mock/*` route does the same four things before it can talk to REST:
 * read the session, resolve the caller's tenant slug, mint a Bearer JWT, and turn a REST failure
 * into the `{ success: false, error }` envelope the ADE dialogs read. The scenarios route (#4454)
 * wrote that out by hand; correlation, the authoring catalogue and the dry-run preview would have
 * made four copies of it, so it lives here once.
 *
 * REST reports mock validation failures as `detail: { message, errors[] }` (HTTP 422). That shape
 * is preserved through {@link restErrorResponse} rather than flattened, because MSC-1.3 attaches
 * each message to the row that caused it — a detached list is the feedback loop the ticket exists
 * to replace.
 */

import { NextResponse } from 'next/server';

import { getAuthSession } from '@lib/auth/server-session';
import { getTenantById } from '@lib/db/helper';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';

/** A resolved caller: the tenant slug REST paths need, plus signed request headers. */
export interface VersionMockProxyContext {
  ok: true;
  tenantSlug: string;
  headers: Record<string, string>;
}

/** A rejected caller: the response the route should return unchanged. */
export interface VersionMockProxyRejection {
  ok: false;
  response: NextResponse;
}

/**
 * Resolve the session and tenant for one version mock proxy call.
 *
 * @returns The tenant slug and signed headers, or the error response to return as-is
 * (401 unauthenticated, 400 with no tenant selected, 404 when the tenant record is gone).
 */
export async function resolveVersionMockContext(): Promise<
  VersionMockProxyContext | VersionMockProxyRejection
> {
  const session = await getAuthSession();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const user = session.user as { current_tenant_id?: string; user_id?: string };
  const tenantId = user.current_tenant_id;
  if (!tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 }),
    };
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant?.slug) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 }),
    };
  }

  return {
    ok: true,
    tenantSlug: tenant.slug,
    headers: createRestAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    }),
  };
}

/**
 * Build the REST URL for one version mock sub-resource.
 *
 * @param tenantSlug - The caller's tenant slug.
 * @param projectId - The project that owns the version.
 * @param versionId - The version record id.
 * @param suffix - The sub-resource path, e.g. `mock/correlation`.
 * @returns The absolute REST URL.
 */
export function versionMockUrl(
  tenantSlug: string,
  projectId: string,
  versionId: string,
  suffix: string
): string {
  return `${REST_API_BASE_URL}/versions/${tenantSlug}/${encodeURIComponent(projectId)}/${encodeURIComponent(versionId)}/${suffix}`;
}

/**
 * Convert a failed REST response body into the ADE's error envelope.
 *
 * REST returns `detail: { message, errors[] }` for the mock validation routes and a plain string
 * detail everywhere else. Both are preserved: `errors` is what the editors attach to the offending
 * row, and losing it would leave an author with a save that failed and no idea where.
 *
 * @param data - The parsed REST body (may be `null` when the response was not JSON).
 * @param status - The REST status code, forwarded unchanged.
 * @param fallback - The message to use when REST said nothing useful.
 * @returns The `{ success: false, error, errors? }` response.
 */
export function restErrorResponse(data: unknown, status: number, fallback: string): NextResponse {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (detail && typeof detail === 'object' && Array.isArray((detail as { errors?: unknown }).errors)) {
    const structured = detail as { message?: string; errors: unknown[] };
    return NextResponse.json(
      {
        success: false,
        error: structured.message ?? fallback,
        errors: structured.errors as string[],
      },
      { status }
    );
  }
  return NextResponse.json(
    { success: false, error: (typeof detail === 'string' && detail) || fallback },
    { status }
  );
}
