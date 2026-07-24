/**
 * API Proxy for Version Mock Scenario Overrides (#4454, SIM-4.2)
 * and Latency/Chaos Injection knobs (#4455, SIM-4.3)
 *
 * Proxies the Control Panel scenario editor to the REST API with JWT authentication:
 * - `GET /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/scenarios`
 * - `PUT /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/scenarios`
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
 * Resolve the session + tenant slug shared by both handlers.
 * Returns either the resolved context or a ready-to-return error response.
 */
async function resolveContext(): Promise<
  | { ok: true; tenantSlug: string; headers: Record<string, string> }
  | { ok: false; response: NextResponse }
> {
  const session = await getAuthSession();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const user = session.user as { current_tenant_id?: string; user_id?: string };
  const tenantId = user.current_tenant_id;
  if (!tenantId) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 }),
    };
  }

  const tenant = await getTenantById(tenantId);
  if (!tenant || !tenant.slug) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 }),
    };
  }

  const headers = createAuthHeaders({
    user_id: user.user_id,
    email: session.user.email,
    name: session.user.name,
    current_tenant_id: tenantId,
  });

  return { ok: true, tenantSlug: tenant.slug, headers };
}

/**
 * GET /api/versions/[versionId]/mock/scenarios?projectId=...
 *
 * Returns `{ success, scenarios, chaos }` with the version's persisted
 * scenario definitions and latency/chaos knobs (`chaos` is null when unset).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }

    const context = await resolveContext();
    if (!context.ok) return context.response;

    const response = await fetch(
      `${REST_API_BASE_URL}/versions/${context.tenantSlug}/${projectId}/${versionId}/mock/scenarios`,
      { method: 'GET', headers: context.headers }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        (data && typeof data.detail === 'string' && data.detail) || 'Failed to load mock scenarios';
      return NextResponse.json({ success: false, error }, { status: response.status });
    }

    return NextResponse.json({
      success: true,
      scenarios: data?.scenarios ?? {},
      chaos: data?.chaos ?? null,
    });
  } catch (error) {
    console.error('Error loading mock scenarios:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}

/**
 * PUT /api/versions/[versionId]/mock/scenarios
 *
 * Replace the version's scenario definitions and chaos knobs. Body:
 * `{ projectId, scenarios, chaos? }` — omitting `chaos` clears the stored knobs.
 * Returns `{ success, scenarios, chaos }`, or `{ success: false, error, errors }`
 * where `errors` lists the validation failures reported by REST (HTTP 422).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
    const body = await request.json();
    const { projectId, scenarios, chaos } = body as {
      projectId?: string;
      scenarios?: unknown;
      chaos?: unknown;
    };

    if (!projectId) {
      return NextResponse.json(
        { success: false, error: 'Project ID is required' },
        { status: 400 }
      );
    }
    if (!scenarios || typeof scenarios !== 'object' || Array.isArray(scenarios)) {
      return NextResponse.json(
        { success: false, error: '`scenarios` must be an object' },
        { status: 400 }
      );
    }
    if (chaos !== undefined && (!chaos || typeof chaos !== 'object' || Array.isArray(chaos))) {
      return NextResponse.json(
        { success: false, error: '`chaos` must be an object when provided' },
        { status: 400 }
      );
    }

    const context = await resolveContext();
    if (!context.ok) return context.response;

    const response = await fetch(
      `${REST_API_BASE_URL}/versions/${context.tenantSlug}/${projectId}/${versionId}/mock/scenarios`,
      {
        method: 'PUT',
        headers: context.headers,
        body: JSON.stringify({ scenarios, ...(chaos !== undefined ? { chaos } : {}) }),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = data?.detail;
      // REST reports scenario validation failures as {message, errors} in detail.
      if (detail && typeof detail === 'object' && Array.isArray(detail.errors)) {
        return NextResponse.json(
          { success: false, error: detail.message ?? 'Scenario validation failed', errors: detail.errors },
          { status: response.status }
        );
      }
      const error =
        (typeof detail === 'string' && detail) || 'Failed to save mock scenarios';
      return NextResponse.json({ success: false, error }, { status: response.status });
    }

    return NextResponse.json({
      success: true,
      scenarios: data?.scenarios ?? {},
      chaos: data?.chaos ?? null,
    });
  } catch (error) {
    console.error('Error saving mock scenarios:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 });
  }
}
