/**
 * Proxy GET for the stored classified version changelog (CTG-3.2, #4476).
 *
 * Forwards to the REST API's
 * `GET /v1/versions/{tenant}/{project}/{revision}/changelog`, which returns the
 * persisted `ctg.changelog.v1` payload written on publish (CTG-3.1).
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

async function handleRestResponse(
  response: Response,
  defaultError: string,
): Promise<{ data: unknown; error: string | null; status: number }> {
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    return { data: null, error: text || defaultError, status: response.status || 500 };
  }
  const data = await response.json();
  if (!response.ok) {
    const detail = data?.detail;
    const err =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? JSON.stringify(detail)
          : defaultError;
    return { data: null, error: err, status: response.status };
  }
  return { data, error: null, status: response.status };
}

/**
 * GET /api/versions/[versionId]/changelog?projectId=xxx
 * Stored classified changelog for one published revision.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> },
) {
  try {
    const { versionId } = await params;
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as { current_tenant_id?: string; user_id?: string };
    const tenantId = user.current_tenant_id;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ success: false, error: 'Project ID is required' }, { status: 400 });
    }
    const tenant = await getTenantById(tenantId);
    if (!tenant?.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });
    const url = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(projectId)}/${encodeURIComponent(versionId)}/changelog`;
    const response = await fetch(url, { method: 'GET', headers });
    const { data, error, status } = await handleRestResponse(response, 'Failed to load changelog');
    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }
    return NextResponse.json({ success: true, changelog: data });
  } catch (error) {
    console.error('version changelog GET:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
