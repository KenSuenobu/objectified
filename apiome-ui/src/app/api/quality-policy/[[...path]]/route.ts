/**
 * API proxy for the tenant import/export quality policy — IXH-2.3 (#5098)
 *
 * Optional catch-all proxy that forwards `/api/quality-policy/<...>` to the REST service's
 * tenant-scoped `/v1/tenants/{tenantSlug}/governance/<...>` endpoints, minting a short-lived JWT
 * from the authenticated session exactly like the style-guides proxy. The current tenant slug is
 * resolved server-side from the session's `current_tenant_id`, so the browser never sends it.
 *
 * Examples:
 *   GET  /api/quality-policy                    -> GET  /v1/tenants/{slug}/governance/quality-policy
 *   PUT  /api/quality-policy                    -> PUT  /v1/tenants/{slug}/governance/quality-policy
 *   GET  /api/quality-policy/versions           -> GET  /v1/tenants/{slug}/governance/quality-policy/versions
 *   GET  /api/quality-policy/waivers            -> GET  /v1/tenants/{slug}/governance/quality-waivers
 *   POST /api/quality-policy/waivers            -> POST /v1/tenants/{slug}/governance/quality-waivers
 *
 * Authorization is the REST layer's job: policy writes are tenant-admin-only and a waiver grant is
 * refused unless the policy names the caller's role. This proxy only carries the session.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById } from '@lib/db/helper';
import { getJwtSigningSecret } from '@lib/rest-auth';

const REST_API_BASE_URL = process.env.NEXT_PUBLIC_REST_API_BASE_URL || 'http://localhost:8000/v1';

export const dynamic = 'force-dynamic';

interface SessionUser {
  user_id?: string;
  email?: string | null;
  name?: string | null;
  current_tenant_id?: string;
}

/** Build a Bearer JWT from the session for the REST call (HS256, 1h), matching the other proxies. */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  const secret = getJwtSigningSecret();
  if (!user.user_id || !secret) {
    return { 'Content-Type': 'application/json' };
  }
  const token = jwt.sign(
    {
      user_id: user.user_id,
      sub: user.user_id,
      email: user.email,
      name: user.name,
      current_tenant_id: user.current_tenant_id,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/** Resolve the session + current tenant slug, or return an error response to send back verbatim. */
async function resolveContext(): Promise<
  | { ok: true; headers: Record<string, string>; tenantSlug: string }
  | { ok: false; response: NextResponse }
> {
  const session = await getAuthSession();
  if (!session?.user) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }
  const user = session.user as SessionUser;
  if (!user.current_tenant_id) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 }),
    };
  }
  const tenant = await getTenantById(user.current_tenant_id);
  if (!tenant || !tenant.slug) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 }),
    };
  }
  return {
    ok: true,
    tenantSlug: tenant.slug,
    headers: createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: user.current_tenant_id,
    }),
  };
}

/**
 * Map the browser-facing sub-path onto the REST governance path.
 *
 * The UI talks about "the quality policy" and "its waivers"; REST models them as two sibling
 * governance resources. Translating here keeps the client from having to know that.
 */
function restPath(segments: string[] | undefined): string {
  const parts = segments ?? [];
  if (parts[0] === 'waivers') {
    return ['quality-waivers', ...parts.slice(1)].map(encodeURIComponent).join('/');
  }
  return ['quality-policy', ...parts].map(encodeURIComponent).join('/');
}

/** Forward the request to the REST API and translate the response back to the browser. */
async function forward(
  request: NextRequest,
  segments: string[] | undefined,
  method: string,
  withBody: boolean,
): Promise<NextResponse> {
  try {
    const ctx = await resolveContext();
    if (!ctx.ok) return ctx.response;

    const search = request.nextUrl.search || '';
    const url = `${REST_API_BASE_URL}/tenants/${encodeURIComponent(ctx.tenantSlug)}/governance/${restPath(segments)}${search}`;

    const init: RequestInit = { method, headers: ctx.headers };
    if (withBody) {
      const body = await request.text();
      if (body) init.body = body;
    }

    const response = await fetch(url, init);
    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (!response.ok) {
      // FastAPI errors arrive as `detail`: a string, or an object (the blocked-import verdict).
      return NextResponse.json(
        { success: false, error: (data && (data.detail || data.error)) || 'Request failed' },
        { status: response.status },
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

type RouteCtx = { params: Promise<{ path?: string[] }> };

export async function GET(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'GET', false);
}

export async function PUT(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'PUT', true);
}

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'POST', true);
}
