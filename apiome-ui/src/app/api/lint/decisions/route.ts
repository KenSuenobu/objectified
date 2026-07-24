/**
 * POST /api/lint/decisions — create/update a finding waiver (CLX-1.3, #4850).
 * GET  /api/lint/decisions — list decisions (optional ?projectId=).
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
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${encodedToken}`,
  };
}

async function tenantContext(user: SessionUser) {
  const tenantId = user.current_tenant_id;
  if (!tenantId) return { error: NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 }) };
  const tenant = await getTenantById(tenantId);
  if (!tenant?.slug) {
    return { error: NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 }) };
  }
  return { tenant };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const ctx = await tenantContext(user);
    if ('error' in ctx) return ctx.error;

    // The lint decisions router takes the tenant slug as a query parameter (CLX-4.1 fix:
    // without it the REST call fails validation and decisions silently never load).
    const params = new URLSearchParams({ tenant_slug: ctx.tenant.slug });
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (projectId) params.set('projectId', projectId);
    const response = await fetch(`${REST_API_BASE_URL}/lint/decisions?${params.toString()}`, {
      method: 'GET',
      headers: createAuthHeaders(user),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json({ success: false, ...(typeof data === 'object' && data ? data : {}) }, { status: response.status });
    }
    return NextResponse.json({ success: true, ...(typeof data === 'object' && data ? data : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const ctx = await tenantContext(user);
    if ('error' in ctx) return ctx.error;

    const body = await request.json();
    const response = await fetch(
      `${REST_API_BASE_URL}/lint/decisions?tenant_slug=${encodeURIComponent(ctx.tenant.slug)}`,
      {
        method: 'POST',
        headers: createAuthHeaders(user),
        body: JSON.stringify(body),
      },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json({ success: false, ...(typeof data === 'object' && data ? data : {}) }, { status: response.status });
    }
    return NextResponse.json({ success: true, ...(typeof data === 'object' && data ? data : {}) }, { status: response.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
