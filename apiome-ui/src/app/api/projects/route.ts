/**
 * API Proxy for Projects Management
 *
 * Proxies requests to the REST API with JWT authentication from authenticated session.
 * This ensures the UI application uses the REST API for all project operations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById } from '@lib/db/helper';
import { isProjectPublishable, type PublishableProjectLike } from '@/app/utils/catalog-publishable';
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
 * Creates a JWT token from the session for authentication
 */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  console.log('[projects] createAuthHeaders called with:', {
    user_id: user.user_id,
    email: user.email,
    current_tenant_id: user.current_tenant_id,
  });

  if (!user.user_id) {
    console.error('[projects] No user_id in session');
    return { 'Content-Type': 'application/json' };
  }

  const secret = getJwtSigningSecret();
  if (!secret) {
    console.error('[projects] BETTER_AUTH_SECRET not configured');
    return { 'Content-Type': 'application/json' };
  }

  // Create a JWT token with user info for the REST API
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

  console.log('[projects] JWT created successfully for user:', user.user_id);

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
 * GET /api/projects
 * List all projects for the current tenant
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
    const querySuffix = includeDeleted ? '?include_deleted=true' : '';

    // Catalog/Projects boundary (#4587): catalog items (publishable=false, MFI-23.1) are excluded
    // from this list by default, so every Projects-surface consumer — the Projects page and the
    // project pickers in Studio, Database, Migration, the sunset timeline, and repository import
    // mapping — upholds the boundary without needing its own filter. `include_catalog=true` opts
    // back in; the versions page uses it because it must resolve owning projects for the publish
    // gate (MFI-23.8) and honor catalog deep-links. Catalog surfaces list via `/api/catalog`.
    const includeCatalogParam = request.nextUrl.searchParams.get('include_catalog');
    const includeCatalog =
      includeCatalogParam === 'true' || includeCatalogParam === '1';

    // Build REST API URL
    const url = `${REST_API_BASE_URL}/projects/${tenantSlug}${querySuffix}`;

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

    const { data, error, status } = await handleRestResponse(response, 'Failed to fetch projects');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    const projects =
      Array.isArray(data) && !includeCatalog
        ? data.filter((p) => isProjectPublishable(p as PublishableProjectLike))
        : data;

    return NextResponse.json({ success: true, projects });
  } catch (error) {
    console.error('Error fetching projects:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * POST /api/projects
 * Create a new project
 */
export async function POST(request: NextRequest) {
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

    // Get request body
    const body = await request.json();

    // Create auth headers with JWT token from session
    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    // Forward request to REST API
    const response = await fetch(`${REST_API_BASE_URL}/projects/${tenantSlug}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const { data, error, status } = await handleRestResponse(response, 'Failed to create project');

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, project: data });
  } catch (error) {
    console.error('Error creating project:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }
}
