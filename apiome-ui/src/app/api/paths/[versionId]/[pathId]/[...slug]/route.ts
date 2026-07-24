/**
 * Catch-all API Proxy for nested Path operations
 *
 * Handles all remaining path operations like:
 * - /request-bodies, /request-bodies/[id]/content-types
 * - /responses, /responses/[id]/content-types
 * - /parameters
 * - /operations/[id]/description
 * - /operations/[id]/parameters/[parameterId]/link
 * - /operations/[id]/request-body/[requestBodyId]/link
 * - /operations/[id]/responses/[responseId]/link
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
    'Authorization': `Bearer ${encodedToken}`,
  };
}

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

async function getAuthContext(session: any) {
  const user = session.user as { current_tenant_id?: string; user_id?: string };
  const tenantId = user.current_tenant_id;

  if (!tenantId) {
    return { error: 'No tenant selected', status: 400 };
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant || !tenant.slug) {
    return { error: 'Tenant not found', status: 404 };
  }

  const headers = createAuthHeaders({
    user_id: user.user_id,
    email: session.user.email,
    name: session.user.name,
    current_tenant_id: tenantId,
  });

  return { tenant, headers, error: null };
}

async function proxyRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: any
): Promise<NextResponse> {
  const fetchOptions: RequestInit = { method, headers };
  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const { data, error, status } = await handleRestResponse(response, `Failed ${method} request`);

  if (error) {
    return NextResponse.json({ success: false, error }, { status });
  }

  return NextResponse.json({ success: true, data });
}

/**
 * GET handler for catch-all route
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string; slug: string[] }> }
) {
  try {
    const { versionId, pathId, slug } = await params;
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const context = await getAuthContext(session);
    if (context.error) {
      return NextResponse.json({ success: false, error: context.error }, { status: context.status! });
    }

    const subPath = slug.join('/');
    const url = `${REST_API_BASE_URL}/paths/${context.tenant!.slug}/${versionId}/${pathId}/${subPath}`;

    return proxyRequest('GET', url, context.headers!);
  } catch (error) {
    console.error('Error in catch-all GET:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * POST handler for catch-all route
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string; slug: string[] }> }
) {
  try {
    const { versionId, pathId, slug } = await params;
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const context = await getAuthContext(session);
    if (context.error) {
      return NextResponse.json({ success: false, error: context.error }, { status: context.status! });
    }

    let body = null;
    try {
      body = await request.json();
    } catch {
      // Empty body is okay for some POST requests (like link operations)
    }

    const subPath = slug.join('/');
    const url = `${REST_API_BASE_URL}/paths/${context.tenant!.slug}/${versionId}/${pathId}/${subPath}`;

    return proxyRequest('POST', url, context.headers!, body);
  } catch (error) {
    console.error('Error in catch-all POST:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * PUT handler for catch-all route
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string; slug: string[] }> }
) {
  try {
    const { versionId, pathId, slug } = await params;
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const context = await getAuthContext(session);
    if (context.error) {
      return NextResponse.json({ success: false, error: context.error }, { status: context.status! });
    }

    const body = await request.json();
    const subPath = slug.join('/');
    const url = `${REST_API_BASE_URL}/paths/${context.tenant!.slug}/${versionId}/${pathId}/${subPath}`;

    return proxyRequest('PUT', url, context.headers!, body);
  } catch (error) {
    console.error('Error in catch-all PUT:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * DELETE handler for catch-all route
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string; slug: string[] }> }
) {
  try {
    const { versionId, pathId, slug } = await params;
    const session = await getAuthSession();

    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const context = await getAuthContext(session);
    if (context.error) {
      return NextResponse.json({ success: false, error: context.error }, { status: context.status! });
    }

    const subPath = slug.join('/');
    const url = `${REST_API_BASE_URL}/paths/${context.tenant!.slug}/${versionId}/${pathId}/${subPath}`;

    return proxyRequest('DELETE', url, context.headers!);
  } catch (error) {
    console.error('Error in catch-all DELETE:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
