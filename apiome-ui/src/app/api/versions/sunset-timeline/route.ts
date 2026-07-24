/**
 * GET /api/versions/sunset-timeline?projectId=optional
 * Proxies to REST GET /v1/versions/{tenantSlug}/sunset-timeline (#508).
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

function createAuthHeaders(user: SessionUser): Record<string, string> {
  if (!user.user_id) {
    throw new Error('Unable to create authorization token: session user_id is missing');
  }
  const secret = getJwtSigningSecret();
  if (!secret) {
    throw new Error('Unable to create authorization token: BETTER_AUTH_SECRET is not configured');
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
    Authorization: `Bearer ${encodedToken}`,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const user = session.user as SessionUser;
    const tenantId = user.current_tenant_id;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant?.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const url = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenant.slug)}/sunset-timeline${qs}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: createAuthHeaders({
        user_id: user.user_id,
        email: session.user.email,
        name: session.user.name,
        current_tenant_id: tenantId,
      }),
    });

    const contentType = response.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      const text = await response.text();
      return NextResponse.json(
        { success: false, error: text || 'Unexpected response from API' },
        { status: response.status || 500 }
      );
    }

    const data = await response.json();
    if (!response.ok) {
      const detail = typeof data?.detail === 'string' ? data.detail : 'Request failed';
      return NextResponse.json({ success: false, error: detail }, { status: response.status });
    }

    return NextResponse.json({ success: true, entries: data.entries ?? [] });
  } catch (error) {
    console.error('[sunset-timeline]', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
