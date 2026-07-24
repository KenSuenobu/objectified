/**
 * API Proxy for Individual Version Operations
 *
 * Proxies requests to the REST API with JWT authentication.
 * Handles GET, PUT, DELETE operations for specific versions.
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
 * Helper to handle REST API responses
 */
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
 * GET /api/versions/[versionId]?projectId=xxx
 * Get a specific version by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
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

    // Get project ID from query params
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
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

    const tenantSlug = tenant.slug;

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const sr = searchParams.get('successorResolution');
    const ar = searchParams.get('auditSuccessorResolution');
    const qs = new URLSearchParams();
    if (sr) qs.set('successorResolution', sr);
    if (ar) qs.set('auditSuccessorResolution', ar);
    const q = qs.toString();
    const restUrl = `${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}/${versionId}${q ? `?${q}` : ''}`;

    const ifNoneMatch = request.headers.get('if-none-match');
    const fetchHeaders: Record<string, string> = { ...headers };
    if (ifNoneMatch) {
      fetchHeaders['If-None-Match'] = ifNoneMatch;
    }

    const response = await fetch(restUrl, {
      method: 'GET',
      headers: fetchHeaders,
      redirect: sr === 'redirect' ? 'manual' : 'follow',
    });

    if (response.status === 304) {
      const res = new NextResponse(null, { status: 304 });
      const etag = response.headers.get('ETag');
      if (etag) {
        res.headers.set('ETag', etag);
      }
      response.headers.forEach((value, key) => {
        if (key.toLowerCase().startsWith('x-apiome-')) {
          res.headers.set(key, value);
        }
      });
      return res;
    }

    if (response.status === 307 || response.status === 308) {
      const loc = response.headers.get('Location');
      if (loc) {
        try {
          const remote = new URL(loc, restUrl);
          const segs = remote.pathname.replace(/\/$/, '').split('/').filter(Boolean);
          const finalRevisionId = segs[segs.length - 1] ?? versionId;
          const dest = new URL(request.url);
          dest.pathname = `/api/versions/${encodeURIComponent(finalRevisionId)}`;
          dest.searchParams.set('projectId', projectId);
          dest.searchParams.set('successorResolution', 'none');
          return NextResponse.redirect(dest, 307);
        } catch {
          /* fall through */
        }
      }
    }

    const { data, error, status } = await handleRestResponse(response, 'Failed to fetch version');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    const res = NextResponse.json({ success: true, version: data });
    const restEtag = response.headers.get('ETag');
    if (restEtag) {
      res.headers.set('ETag', restEtag);
    }
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith('x-apiome-')) {
        res.headers.set(key, value);
      }
    });
    return res;
  } catch (error) {
    console.error('Error fetching version:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/versions/[versionId]
 * Update a specific version
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
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

    const tenantSlug = tenant.slug;
    const body = await request.json();
    const { projectId, ...updateData } = body;

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}/${versionId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(updateData),
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to update version');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, version: data });
  } catch (error) {
    console.error('Error updating version:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/versions/[versionId]?projectId=xxx
 * Delete a specific version
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
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

    // Get project ID from query params
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
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

    const tenantSlug = tenant.slug;

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/versions/${tenantSlug}/${projectId}/${versionId}`, {
      method: 'DELETE',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to delete version');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, message: data });
  } catch (error) {
    console.error('Error deleting version:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
