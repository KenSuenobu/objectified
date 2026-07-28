/**
 * API Proxy for the verification-target registry — ECA-1.2 (#4730)
 *
 * Catch-all proxy that forwards `/api/verification-targets/<...>` to the REST service's
 * tenant-scoped `/v1/tenants/{tenantSlug}/verification-targets/<...>` endpoints, minting a
 * short-lived JWT from the authenticated session exactly like the other UI proxies. The current
 * tenant slug is resolved server-side from the session's `current_tenant_id`, so the browser never
 * needs it — and never gets to choose it.
 *
 * The browser talks to this route, not to REST: a target definition names a URL and a credential
 * *reference*, and the RBAC decision (`verification_targets:view|create|edit|delete`) belongs to
 * the REST service holding the session's identity, not to client code.
 *
 * Examples:
 *   GET    /api/verification-targets                   -> GET    /v1/tenants/{slug}/verification-targets
 *   POST   /api/verification-targets                   -> POST   /v1/tenants/{slug}/verification-targets
 *   GET    /api/verification-targets/staging           -> GET    /v1/tenants/{slug}/verification-targets/staging
 *   PATCH  /api/verification-targets/staging           -> PATCH  /v1/tenants/{slug}/verification-targets/staging
 *   DELETE /api/verification-targets/staging           -> DELETE /v1/tenants/{slug}/verification-targets/staging
 *   POST   /api/verification-targets/staging/resolve   -> POST   /v1/tenants/{slug}/verification-targets/staging/resolve
 *   GET    /api/verification-targets/audit             -> GET    /v1/tenants/{slug}/verification-targets-audit
 *
 * The `audit` sub-path is the one rewrite: REST keeps the ledger on a sibling path
 * (`verification-targets-audit`) so `audit` can never be mistaken for a target named "audit".
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

/**
 * Build the upstream URL for a request.
 *
 * A bare `audit` sub-path maps onto the REST sibling resource; everything else is appended to the
 * collection path segment by segment (each encoded, so a slug can never inject a path).
 */
function upstreamPath(tenantSlug: string, segments: string[]): string {
  if (segments.length === 1 && segments[0] === 'audit') {
    return `${REST_API_BASE_URL}/tenants/${tenantSlug}/verification-targets-audit`;
  }
  const subPath = segments.map(encodeURIComponent).join('/');
  const suffix = subPath ? `/${subPath}` : '';
  return `${REST_API_BASE_URL}/tenants/${tenantSlug}/verification-targets${suffix}`;
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

    const search = request.nextUrl.search || '';
    const url = `${upstreamPath(ctx.tenantSlug, segments)}${search}`;

    const init: RequestInit = { method, headers: ctx.headers, cache: 'no-store' };
    if (withBody) {
      const body = await request.text();
      if (body) init.body = body;
    }

    const response = await fetch(url, init);

    // 204 No Content (retire a target) carries no body.
    if (response.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await response.json();
    if (!response.ok) {
      // REST refusals arrive as `{detail: {code, message}}` for every registry fault, so the
      // stable code survives to the client rather than being flattened into prose.
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

type RouteCtx = { params: Promise<{ path?: string[] }> };

export async function GET(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path ?? [], 'GET', false);
}

export async function POST(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path ?? [], 'POST', true);
}

export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path ?? [], 'PATCH', true);
}

export async function DELETE(request: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(request, path ?? [], 'DELETE', false);
}
