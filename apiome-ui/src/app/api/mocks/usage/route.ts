/**
 * API Proxy for Mock Usage Rollups (#4443, SIM-2.2)
 *
 * Proxies the Control Panel usage sparkline data to the REST API with JWT
 * authentication: `GET /v1/mocks/{tenantSlug}/usage` (#4420, SIM-1.5).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById } from '@lib/db/helper';
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
 * GET /api/mocks/usage?days=30&projectSlug=...&versionLabel=...
 *
 * Returns `{ success, usage }` where `usage` is the REST MockUsageResponse:
 * tenant-wide counters plus `dailyRollups` (optionally filtered by project/version).
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

    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json(
        { success: false, error: 'Tenant not found' },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const restParams = new URLSearchParams();
    const days = searchParams.get('days');
    const projectSlug = searchParams.get('projectSlug');
    const versionLabel = searchParams.get('versionLabel');
    if (days) restParams.set('days', days);
    if (projectSlug) restParams.set('project_slug', projectSlug);
    if (versionLabel) restParams.set('version_label', versionLabel);
    const qs = restParams.toString();

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/mocks/${tenant.slug}/usage${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      headers,
    });

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await response.text();
      return NextResponse.json(
        { success: false, error: text || 'Failed to fetch mock usage' },
        { status: response.status || 500 }
      );
    }

    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.detail || 'Failed to fetch mock usage' },
        { status: response.status }
      );
    }

    return NextResponse.json({ success: true, usage: data });
  } catch (error) {
    console.error('Error fetching mock usage:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
