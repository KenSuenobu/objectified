/**
 * API Proxy for single Path operations
 *
 * Proxies GET/PUT/DELETE requests to the REST API with JWT authentication.
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

/**
 * GET /api/paths/[versionId]/[pathId]
 * Get a single path with operations
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string }> }
) {
  try {
    const { versionId, pathId } = await params;
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

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/paths/${tenant.slug}/${versionId}/${pathId}`, {
      method: 'GET',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to get path');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, path: data });
  } catch (error) {
    console.error('Error getting path:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * PUT /api/paths/[versionId]/[pathId]
 * Update a path
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string }> }
) {
  try {
    const { versionId, pathId } = await params;
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
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/paths/${tenant.slug}/${versionId}/${pathId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to update path');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, path: data });
  } catch (error) {
    console.error('Error updating path:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * DELETE /api/paths/[versionId]/[pathId]
 * Delete a path
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string; pathId: string }> }
) {
  try {
    const { versionId, pathId } = await params;
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

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/paths/${tenant.slug}/${versionId}/${pathId}`, {
      method: 'DELETE',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to delete path');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting path:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
