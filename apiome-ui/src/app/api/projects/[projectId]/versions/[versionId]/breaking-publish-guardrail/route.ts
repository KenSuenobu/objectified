/**
 * GET /api/projects/[projectId]/versions/[versionId]/breaking-publish-guardrail
 * Proxies to REST GET /v1/versions/{tenantSlug}/{projectId}/{versionId}/breaking-publish-guardrail
 *
 * Preflights the CTG-3.4 (#4478) guardrail for the publish dialog: whether this revision breaks
 * consumers without a semver major bump, which changes are breaking, and whether the tenant's
 * style-guide policy warns or blocks. Read-only — nothing is published or stored.
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

/** Mint the short-lived REST bearer token for the signed-in user. */
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; versionId: string }> }
) {
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
    const { projectId, versionId } = await params;
    const url =
      `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenant.slug)}` +
      `/${encodeURIComponent(projectId)}/${encodeURIComponent(versionId)}/breaking-publish-guardrail`;
    const response = await fetch(url, {
      method: 'GET',
      headers: createAuthHeaders(user),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return NextResponse.json(
        { success: false, error: text || 'Invalid JSON from REST API' },
        { status: response.status || 500 }
      );
    }
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          ...(typeof data === 'object' && data !== null ? (data as object) : { detail: data }),
        },
        { status: response.status }
      );
    }
    return NextResponse.json({
      success: true,
      ...(typeof data === 'object' && data !== null ? (data as object) : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
