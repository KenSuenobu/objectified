/**
 * API Proxy for Version Mock Toggle (#4443, SIM-2.2)
 *
 * Proxies the Control Panel mock toggle to the REST API with JWT authentication:
 * `PUT /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock` (#4422, SIM-2.1).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById } from '@lib/db/helper';
import { applyUiMockBaseUrl } from '@lib/mock/mockUrl';
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
 */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  if (!user.user_id) {
    return { 'Content-Type': 'application/json' };
  }

  const secret = getJwtSigningSecret();
  if (!secret) {
    return { 'Content-Type': 'application/json' };
  }

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

  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${encodedToken}`,
  };
}

/**
 * Helper to handle REST API responses
 */
async function handleRestResponse(response: Response, defaultError: string): Promise<{ data: unknown; error: string | null; status: number }> {
  const contentType = response.headers.get('content-type');

  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    return { data: null, error: text || defaultError, status: response.status || 500 };
  }

  const data = await response.json();

  if (!response.ok) {
    return { data: null, error: data.detail || defaultError, status: response.status };
  }

  return { data, error: null, status: response.status };
}

/**
 * PUT /api/versions/[versionId]/mock
 *
 * Enable or disable the hosted mock for a version. Body: `{ projectId, enabled }`.
 * Returns `{ success, version }` where `version` is the updated REST VersionSchema
 * (including `mockEnabled` and the computed `mockBaseUrl`).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
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

    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json(
        { success: false, error: 'Tenant not found' },
        { status: 404 }
      );
    }

    const tenantSlug = tenant.slug;
    const body = await request.json();
    const { projectId, enabled } = body as { projectId?: string; enabled?: boolean };

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }

    if (typeof enabled !== 'boolean') {
      return NextResponse.json(
        { success: false, error: '`enabled` must be a boolean' },
        { status: 400 }
      );
    }

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}/${versionId}/mock`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled }),
    });

    const { data, error, status } = await handleRestResponse(
      response,
      `Failed to ${enabled ? 'enable' : 'disable'} mock`
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({
      success: true,
      version: applyUiMockBaseUrl(
        data && typeof data === 'object' ? (data as Record<string, unknown>) : {},
        tenantSlug
      ),
    });
  } catch (error) {
    console.error('Error toggling version mock:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
