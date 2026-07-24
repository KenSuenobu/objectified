/**
 * API Proxy for Catalog (MFI-23.2)
 *
 * Proxies requests to the REST API with JWT authentication from the authenticated session, mirroring
 * `src/app/api/projects/route.ts`. The Catalog is the non-publishable slice of projects (the
 * OpenAPI-worthy non-OpenAPI imports, MFI-23.1); items are created by the import routing, not here,
 * so only a read (GET list) is proxied.
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
 * Helper to create authorization headers for REST API calls.
 * Creates a JWT token from the session for authentication.
 */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  if (!user.user_id) {
    console.error('[catalog] No user_id in session');
    return { 'Content-Type': 'application/json' };
  }

  const secret = getJwtSigningSecret();
  if (!secret) {
    console.error('[catalog] BETTER_AUTH_SECRET not configured');
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
    console.error('Non-JSON response from REST API:', text);
    return { data: null, error: text || defaultError, status: response.status || 500 };
  }

  const data = await response.json();

  if (!response.ok) {
    return { data: null, error: data.detail || defaultError, status: response.status };
  }

  return { data, error: null, status: response.status };
}

/**
 * GET /api/catalog
 * List all catalog items for the current tenant.
 *
 * Supports `?include_deleted=true` (parity with `/api/projects`) for trash / restore flows.
 */
export async function GET(request: NextRequest) {
  try {
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

    // Get tenant slug
    const tenant = await getTenantById(tenantId);
    if (!tenant || !tenant.slug) {
      return NextResponse.json(
        { success: false, error: 'Tenant not found' },
        { status: 404 }
      );
    }

    const tenantSlug = tenant.slug;

    const includeDeletedParam = request.nextUrl.searchParams.get('include_deleted');
    const includeDeleted =
      includeDeletedParam === 'true' || includeDeletedParam === '1';
    const identityGroupId = request.nextUrl.searchParams.get('identityGroupId');
    const params = new URLSearchParams();
    if (includeDeleted) params.set('include_deleted', 'true');
    if (identityGroupId) params.set('identityGroupId', identityGroupId);
    const querySuffix = params.toString() ? `?${params.toString()}` : '';

    // Build REST API URL
    const url = `${REST_API_BASE_URL}/catalog/${tenantSlug}${querySuffix}`;

    // Create auth headers with JWT token from session
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    // Forward request to REST API
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to fetch catalog items');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, catalog: data });
  } catch (error) {
    console.error('Error fetching catalog items:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
