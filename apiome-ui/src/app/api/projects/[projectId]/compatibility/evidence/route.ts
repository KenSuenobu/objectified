/**
 * POST /api/projects/[projectId]/compatibility/evidence
 * Proxies to REST POST /v1/versions/{tenantSlug}/{projectId}/compatibility/evidence
 *
 * GET /api/projects/[projectId]/compatibility/evidence?versionId=
 * Proxies to REST GET .../{versionId}/compatibility/evidence
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
    { algorithm: 'HS256', expiresIn: '1h' }
  );
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${encodedToken}`,
  };
}

async function resolveTenantSlug(user: SessionUser): Promise<string | null> {
  const tenantId = user.current_tenant_id;
  if (!tenantId) return null;
  const tenant = await getTenantById(tenantId);
  return tenant?.slug ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const tenantSlug = await resolveTenantSlug(user);
    if (!tenantSlug) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }
    const { projectId } = await params;
    const body = await request.json();
    const baseRevisionId =
      typeof body.baseRevisionId === 'string' ? body.baseRevisionId.trim() : '';
    const headRevisionId =
      typeof body.headRevisionId === 'string' ? body.headRevisionId.trim() : '';
    if (!baseRevisionId || !headRevisionId) {
      return NextResponse.json(
        { success: false, error: 'baseRevisionId and headRevisionId are required' },
        { status: 400 }
      );
    }
    const url = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(projectId)}/compatibility/evidence`;
    const response = await fetch(url, {
      method: 'POST',
      headers: createAuthHeaders(user),
      body: JSON.stringify({ baseRevisionId, headRevisionId }),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';
    return new NextResponse(text, {
      status: response.status,
      headers: { 'Content-Type': contentType },
    });
  } catch (error) {
    console.error('compatibility evidence POST proxy failed', error);
    return NextResponse.json(
      { success: false, error: 'Failed to run compatibility evidence' },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const tenantSlug = await resolveTenantSlug(user);
    if (!tenantSlug) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }
    const { projectId } = await params;
    const versionId = request.nextUrl.searchParams.get('versionId')?.trim() || '';
    if (!versionId) {
      return NextResponse.json(
        { success: false, error: 'versionId query parameter is required' },
        { status: 400 }
      );
    }
    const format = request.nextUrl.searchParams.get('format');
    let url = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(projectId)}/${encodeURIComponent(versionId)}/compatibility/evidence`;
    if (format) {
      url += `?format=${encodeURIComponent(format)}`;
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: createAuthHeaders(user),
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json';
    return new NextResponse(text, {
      status: response.status,
      headers: { 'Content-Type': contentType },
    });
  } catch (error) {
    console.error('compatibility evidence GET proxy failed', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load compatibility evidence' },
      { status: 500 }
    );
  }
}
