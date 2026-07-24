/**
 * API Proxy for Versions Management
 *
 * Proxies requests to the REST API with JWT authentication from authenticated session.
 * This ensures the UI application uses the REST API for all version operations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById, listVersionBranches } from '@lib/db/helper';
import { applyUiMockBaseUrls } from '@lib/mock/mockUrl';
import {
  collectRecentRevisionsOnLineage,
  type VersionLineageRow,
} from '@lib/version-lineage';
import { getJwtSigningSecret } from '@lib/rest-auth';

const REST_API_BASE_URL = process.env.NEXT_PUBLIC_REST_API_BASE_URL || 'http://localhost:8000/v1';

interface SessionUser {
  user_id?: string;
  email?: string | null;
  name?: string | null;
  current_tenant_id?: string;
}

/**
 * Helper to create authorization headers for REST API calls
 * Creates a JWT token from the session for authentication
 */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  console.log('[versions] createAuthHeaders called with:', {
    user_id: user.user_id,
    email: user.email,
    current_tenant_id: user.current_tenant_id,
  });

  if (!user.user_id) {
    console.error('[versions] No user_id in session');
    return { 'Content-Type': 'application/json' };
  }

  const secret = getJwtSigningSecret();
  if (!secret) {
    console.error('[versions] BETTER_AUTH_SECRET not configured');
    return { 'Content-Type': 'application/json' };
  }

  // Create a JWT token with user info for the REST API
  const encodedToken = jwt.sign(
    {
      user_id: user.user_id,
      sub: user.user_id,
      email: user.email,
      name: user.name,
      current_tenant_id: user.current_tenant_id,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  console.log('[versions] JWT created successfully for user:', user.user_id);

  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${encodedToken}`,
  };
}

/**
 * Helper to handle REST API responses (FastAPI uses `{ detail: string | object }` for errors).
 */
async function handleRestResponse(
  response: Response,
  defaultError: string
): Promise<{
  data: unknown;
  error: string | null;
  status: number;
  errorDetail: Record<string, unknown> | null;
}> {
  const contentType = response.headers.get('content-type');

  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    console.error('Non-JSON response from REST API:', text);
    return { data: null, error: text || defaultError, status: response.status || 500, errorDetail: null };
  }

  const data = await response.json();

  if (!response.ok) {
    const detail = (data as { detail?: unknown }).detail;
    let errMsg = defaultError;
    let errorDetail: Record<string, unknown> | null = null;
    if (typeof detail === 'string') {
      errMsg = detail;
    } else if (detail && typeof detail === 'object') {
      errorDetail = detail as Record<string, unknown>;
      const m = (detail as { message?: unknown }).message;
      if (typeof m === 'string') errMsg = m;
    }
    return { data: null, error: errMsg, status: response.status, errorDetail };
  }

  return { data, error: null, status: response.status, errorDetail: null };
}

function nextJsonFromVersionCreateError(
  error: string,
  errorDetail: Record<string, unknown> | null
): Record<string, unknown> {
  const body: Record<string, unknown> = { success: false, error };
  if (!errorDetail) return body;
  if (typeof errorDetail.code === 'string') body.code = errorDetail.code;
  if (typeof errorDetail.currentHeadRevisionId === 'string') {
    body.currentHeadRevisionId = errorDetail.currentHeadRevisionId;
  }
  if ('currentHead' in errorDetail) body.currentHead = errorDetail.currentHead;
  return body;
}

/**
 * List all versions for a project.
 *
 * Supported query parameters:
 * - projectId: Project identifier to list versions for.
 * - lifecycle: Optional lifecycle/status filter.
 * - q: Optional search query (revision note, changelog, commit message body, commit author).
 * - creatorId: Optional creator/user filter.
 * - createdAfter: Optional lower bound for creation timestamp.
 * - createdBefore: Optional upper bound for creation timestamp.
 * - branchId: When set with the project version list, restrict to the first-parent chain from
 *   that named branch's tip (GLI-09). Requires `limit` (defaults to 3; max 25).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const user = session.user as { current_tenant_id?: string; user_id?: string };
    const tenantId = user.current_tenant_id;

    if (!tenantId) {
      return NextResponse.json(
        { success: false, error: 'No tenant selected' },
        { status: 400 }
      );
    }

    // Get project ID from query params
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const lifecycle = searchParams.get('lifecycle');
    const q = searchParams.get('q');
    const creatorId = searchParams.get('creatorId');
    const createdAfter = searchParams.get('createdAfter');
    const createdBefore = searchParams.get('createdBefore');
    const branchId = searchParams.get('branchId')?.trim() ?? '';
    const limitRaw = searchParams.get('limit');
    const lineageLimit = branchId
      ? Math.min(25, Math.max(1, Number.parseInt(limitRaw || '3', 10) || 3))
      : null;

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }

    // Get tenant slug
    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json(
        { success: false, error: 'Tenant not found' },
        { status: 404 }
      );
    }

    const tenantSlug = tenant.slug;

    // Build REST API URL
    // When filtering by branch lineage, skip text/lifecycle/date filters so the full version
    // list is returned and ancestors are not inadvertently excluded (GLI-09 comment feedback).
    const restParams = new URLSearchParams();
    if (!branchId) {
      if (lifecycle) restParams.set('lifecycle', lifecycle);
      if (q) restParams.set('q', q);
      if (creatorId) restParams.set('creatorId', creatorId);
      if (createdAfter) restParams.set('createdAfter', createdAfter);
      if (createdBefore) restParams.set('createdBefore', createdBefore);
    }
    const qs = restParams.toString();
    const url = `${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}${qs ? `?${qs}` : ''}`;

    // Create auth headers with JWT token from session
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    // Forward request to REST API
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to fetch versions');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    if (branchId && lineageLimit !== null) {
      if (!Array.isArray(data)) {
        return NextResponse.json(
          { success: false, error: 'Unexpected versions payload' },
          { status: 500 }
        );
      }
      const rawBranches = await listVersionBranches(projectId, tenantId);
      const branchPayload = JSON.parse(rawBranches) as {
        success?: boolean;
        branches?: Array<{ id: string; tip_version_id: string }>;
        error?: string;
      };
      if (!branchPayload.success || !Array.isArray(branchPayload.branches)) {
        return NextResponse.json(
          { success: false, error: branchPayload.error || 'Failed to resolve branches' },
          { status: 500 }
        );
      }
      const branchRow = branchPayload.branches.find((b) => String(b.id) === branchId);
      if (!branchRow?.tip_version_id?.trim()) {
        return NextResponse.json({ success: false, error: 'Branch not found' }, { status: 404 });
      }
      const lineage = collectRecentRevisionsOnLineage(
        data as VersionLineageRow[],
        branchRow.tip_version_id.trim(),
        lineageLimit
      );
      return NextResponse.json({
        success: true,
        versions: applyUiMockBaseUrls(lineage, tenantSlug),
      });
    }

    return NextResponse.json({
      success: true,
      versions: applyUiMockBaseUrls(Array.isArray(data) ? data : [], tenantSlug),
    });
  } catch (error) {
    console.error('Error fetching versions:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * POST /api/versions
 * Create a new version
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const user = session.user as { current_tenant_id?: string; user_id?: string };
    const tenantId = user.current_tenant_id;

    if (!tenantId) {
      return NextResponse.json(
        { success: false, error: 'No tenant selected' },
        { status: 400 }
      );
    }

    // Get tenant slug
    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json(
        { success: false, error: 'Tenant not found' },
        { status: 404 }
      );
    }

    const tenantSlug = tenant.slug;

    // Get request body
    const body = await request.json();
    const { projectId, ...versionData } = body;

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }

    // Create auth headers with JWT token from session
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    // Forward request to REST API
    const response = await fetch(`${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(versionData),
    });

    const { data, error, status, errorDetail } = await handleRestResponse(response, 'Failed to create version');

    if (error) {
      return NextResponse.json(nextJsonFromVersionCreateError(error, errorDetail), { status });
    }

    return NextResponse.json({ success: true, version: data });
  } catch (error) {
    console.error('Error creating version:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
