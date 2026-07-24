/**
 * API Proxy for Governance Style Guides — GOV-2.1 (#4433)
 *
 * Optional catch-all proxy that forwards `/api/style-guides/<...>` to the REST service's
 * tenant-scoped `/v1/style-guides/{tenantSlug}/<...>` endpoints, minting a short-lived JWT
 * from the authenticated session exactly like the other UI proxies (see `api/access`). The
 * current tenant slug is resolved server-side from the session's `current_tenant_id`, so
 * the browser never needs it.
 *
 * Examples:
 *   GET    /api/style-guides                                  -> GET    /v1/style-guides/{slug}
 *   POST   /api/style-guides                                  -> POST   /v1/style-guides/{slug}
 *   PATCH  /api/style-guides/{id}                             -> PATCH  /v1/style-guides/{slug}/{id}
 *   DELETE /api/style-guides/{id}                             -> DELETE /v1/style-guides/{slug}/{id}
 *   PUT    /api/style-guides/{id}/default                     -> PUT    /v1/style-guides/{slug}/{id}/default
 *   PUT    /api/style-guides/{id}/assignments/projects/{pid}  -> PUT    /v1/style-guides/{slug}/{id}/assignments/projects/{pid}
 *   DELETE /api/style-guides/assignments/projects/{pid}       -> DELETE /v1/style-guides/{slug}/assignments/projects/{pid}
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
    return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  const user = session.user as SessionUser;
  if (!user.current_tenant_id) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 }) };
  }
  const tenant = await getTenantById(user.current_tenant_id);
  if (!tenant || !tenant.slug) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 }) };
  }
  const headers = createAuthHeaders({
    user_id: user.user_id,
    email: session.user.email,
    name: session.user.name,
    current_tenant_id: user.current_tenant_id,
  });
  return { ok: true, headers, tenantSlug: tenant.slug };
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

    const subPath = (segments ?? []).map(encodeURIComponent).join('/');
    const search = request.nextUrl.search || '';
    const url = `${REST_API_BASE_URL}/style-guides/${ctx.tenantSlug}${subPath ? `/${subPath}` : ''}${search}`;

    const init: RequestInit = { method, headers: ctx.headers };
    if (withBody) {
      const body = await request.text();
      if (body) init.body = body;
    }

    const response = await fetch(url, init);

    // 204 No Content carries no body.
    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (!response.ok) {
      // FastAPI errors arrive as `detail`: either a string or a `{code, message}` object
      // (read-only / name-conflict). Both are forwarded so the screen can key off `code`.
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

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'POST', true);
}

export async function PUT(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'PUT', true);
}

export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'PATCH', true);
}

export async function DELETE(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path, 'DELETE', true);
}
