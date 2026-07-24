/**
 * API Proxy for Individual Property Operations
 *
 * Proxies requests to the REST API with JWT authentication.
 * Handles GET, PUT, DELETE operations for specific properties.
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
 * GET /api/properties/[projectId]/[propertyId]
 * Get a specific property by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; propertyId: string }> }
) {
  try {
    const { projectId, propertyId } = await params;
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

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/properties/${tenantSlug}/${projectId}/${propertyId}`, {
      method: 'GET',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to fetch property');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, property: data });
  } catch (error) {
    console.error('Error fetching property:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/properties/[projectId]/[propertyId]
 * Update a specific property
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; propertyId: string }> }
) {
  try {
    const { projectId, propertyId } = await params;
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

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/properties/${tenantSlug}/${projectId}/${propertyId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to update property');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, property: data });
  } catch (error) {
    console.error('Error updating property:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/properties/[projectId]/[propertyId]
 * Delete a specific property
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; propertyId: string }> }
) {
  try {
    const { projectId, propertyId } = await params;
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

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(`${REST_API_BASE_URL}/properties/${tenantSlug}/${projectId}/${propertyId}`, {
      method: 'DELETE',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to delete property');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, message: data });
  } catch (error) {
    console.error('Error deleting property:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
