/**
 * API proxy for the tenant evidence-backed verification policy — ECA-3.1 (#4734)
 *
 * Catch-all proxy that forwards `/api/verification-policy/<...>` to the REST service's
 * tenant-scoped `/v1/tenants/{tenantSlug}/governance/verification-policy/<...>` endpoints,
 * minting a short-lived JWT from the authenticated session exactly like the quality-policy
 * proxy. The current tenant slug is resolved server-side from the session's
 * `current_tenant_id`, so the browser never sends it.
 *
 * Examples:
 *   GET  /api/verification-policy              -> GET  …/governance/verification-policy
 *   PUT  /api/verification-policy              -> PUT  …/governance/verification-policy
 *   GET  /api/verification-policy/versions     -> GET  …/governance/verification-policy/versions
 *   POST /api/verification-policy/evaluate     -> POST …/governance/verification-policy/evaluate
 *   GET  /api/verification-policy/evaluations  -> GET  …/governance/verification-policy/evaluations
 *
 * Authorization is the REST layer's job: policy writes are tenant-admin-only. This proxy only
 * carries the session. The UI must never invent pass/fail — it renders the evaluate payload.
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

/** Map browser sub-path onto REST governance/verification-policy path. */
function restPath(segments: string[] | undefined): string {
  const parts = segments ?? [];
  return ['verification-policy', ...parts].map(encodeURIComponent).join('/');
}

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
