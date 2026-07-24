/**
 * GET /api/projects/[projectId]/version-branches/[branchId]/divergence
 * Proxies to REST GET …/version-branches/{branchId}/divergence (#2721, #2723).
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
    return {};
  }
  const secret = getJwtSigningSecret();
  if (!secret) {
    return {};
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
    Authorization: `Bearer ${encodedToken}`,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; branchId: string }> }
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
    const { projectId, branchId } = await params;
    const against = request.nextUrl.searchParams.get('against');
    const path = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(projectId)}/version-branches/${encodeURIComponent(branchId)}/divergence`;
    const url = against?.trim() ? `${path}?against=${encodeURIComponent(against.trim())}` : path;

    const headers: Record<string, string> = {
      ...createAuthHeaders(user),
    };
    const inm = request.headers.get('if-none-match');
    if (inm) {
      headers['If-None-Match'] = inm;
    }

    const response = await fetch(url, { method: 'GET', headers });
    const etag = response.headers.get('etag');

    if (response.status === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: etag ? { ETag: etag } : {},
      });
    }

    const text = await response.text();
    const outHeaders = new Headers();
    outHeaders.set('Content-Type', 'application/json');
    if (etag) {
      outHeaders.set('ETag', etag);
    }

    if (!response.ok) {
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
      return NextResponse.json(
        {
          ...(typeof body === 'object' && body !== null ? (body as object) : { detail: body }),
          success: false,
        },
        { status: response.status }
      );
    }

    return new NextResponse(text, { status: 200, headers: outHeaders });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
