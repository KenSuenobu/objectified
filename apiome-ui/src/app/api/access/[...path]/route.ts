/**
 * API Proxy for Access & IAM (RBAC) — #3611
 *
 * Catch-all proxy that forwards `/api/access/<...>` to the REST service's tenant-scoped
 * `/v1/access/{tenantSlug}/<...>` endpoints (roles, members, audit, permissions/me), minting a
 * short-lived JWT from the authenticated session exactly like the other UI proxies. The current tenant
 * slug is resolved server-side from the session's `current_tenant_id`, so the browser never needs it.
 *
 * Examples:
 *   GET    /api/access/roles                  -> GET    /v1/access/{slug}/roles
 *   POST   /api/access/roles                  -> POST   /v1/access/{slug}/roles
 *   PUT    /api/access/roles/{id}             -> PUT    /v1/access/{slug}/roles/{id}
 *   GET    /api/access/members                -> GET    /v1/access/{slug}/members
 *   PATCH  /api/access/members/{userId}       -> PATCH  /v1/access/{slug}/members/{userId}
 *   GET    /api/access/audit?filter=role      -> GET    /v1/access/{slug}/audit?filter=role
 *   GET    /api/access/audit/export           -> GET    /v1/access/{slug}/audit/export (CSV)
 *   GET    /api/access/permissions/me         -> GET    /v1/access/{slug}/permissions/me
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
  segments: string[],
  method: string,
  withBody: boolean,
): Promise<NextResponse> {
  try {
    const ctx = await resolveContext();
    if (!ctx.ok) return ctx.response;

    const subPath = segments.map(encodeURIComponent).join('/');
    const search = request.nextUrl.search || '';
    const url = `${REST_API_BASE_URL}/access/${ctx.tenantSlug}/${subPath}${search}`;

    const init: RequestInit = { method, headers: ctx.headers };
    if (withBody) {
      const body = await request.text();
      if (body) init.body = body;
    }

    const response = await fetch(url, init);
    const contentType = response.headers.get('content-type') || '';

    // CSV (audit export) and any other non-JSON payloads are passed straight through.
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      return new NextResponse(text, {
        status: response.status,
        headers: {
          'content-type': contentType || 'text/plain',
          ...(response.headers.get('content-disposition')
            ? { 'content-disposition': response.headers.get('content-disposition') as string }
            : {}),
        },
      });
    }

    // 204 No Content (delete / offboard) carries no body.
    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (!response.ok) {
      // REST errors arrive either as a plain-string `detail` or as the structured
      // `{code, message}` shape (e.g. `license-seats-exhausted`, OLO-5.3). Flatten to a
      // human-readable `error` string and surface the stable machine code separately so
      // client UIs can branch on it without parsing prose.
      const detail = data?.detail;
      const errorMessage =
        typeof detail === 'string'
          ? detail
          : detail && typeof detail.message === 'string'
            ? detail.message
            : (typeof data?.error === 'string' && data.error) || 'Request failed';
      const errorCode =
        detail && typeof detail.code === 'string' ? { code: detail.code } : {};
      return NextResponse.json(
        { success: false, error: errorMessage, ...errorCode },
        { status: response.status },
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

type RouteCtx = { params: Promise<{ path: string[] }> };

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
