/**
 * POST /api/versions/fork
 * Proxies to REST POST /v1/versions/{tenant}/{targetProjectId}/fork
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

async function handleRestResponse(
  response: Response,
  defaultError: string
): Promise<{ data: unknown; error: string | null; status: number }> {
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await response.text();
    return { data: null, error: text || defaultError, status: response.status || 500 };
  }
  const data = await response.json();
  if (!response.ok) {
    const detail = data.detail;
    const msg =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object' && 'message' in detail
          ? String((detail as { message: string }).message)
          : defaultError;
    return { data: null, error: msg, status: response.status };
  }
  return { data, error: null, status: response.status };
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const user = session.user as { current_tenant_id?: string; user_id?: string };
    const tenantId = user.current_tenant_id;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }

    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }

    const body = await request.json();
    const { targetProjectId, ...forkPayload } = body as {
      targetProjectId?: string;
      sourceRevisionId?: string;
      upstreamProjectId?: string | null;
      versionId?: string | null;
      shortMessage?: string | null;
      changelog?: string | null;
      bumpStrategy?: string | null;
    };

    if (!targetProjectId?.trim()) {
      return NextResponse.json({ success: false, error: 'targetProjectId is required' }, { status: 400 });
    }

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const url = `${REST_API_BASE_URL}/versions/${tenant.slug}/${targetProjectId.trim()}/fork`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourceRevisionId: forkPayload.sourceRevisionId,
        upstreamProjectId: forkPayload.upstreamProjectId ?? undefined,
        versionId: forkPayload.versionId ?? undefined,
        shortMessage: forkPayload.shortMessage ?? undefined,
        changelog: forkPayload.changelog ?? undefined,
        bumpStrategy: forkPayload.bumpStrategy ?? undefined,
      }),
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to fork version');
    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }
    return NextResponse.json({ success: true, version: data });
  } catch (error) {
    console.error('Error forking version:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
