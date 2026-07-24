/**
 * POST /api/catalog/[itemId]/convert
 * Proxies to REST POST /v1/catalog/{tenantSlug}/{itemId}/convert
 *
 * The catalog → OpenAPI conversion endpoint (MFI-22.6), the source of the preview screen's live
 * dry-run (MFI-22.4). `?dryRun=true` returns the fidelity report + the would-be OpenAPI document
 * with **no side effects**; `?dryRun=false` (or omitted) runs the convert-to-project/version commit
 * job (MFI-22.5). A catalog item's id is a project id; the REST endpoint resolves its latest
 * revision and enforces the non-publishable slice (a Project's id, or an unknown id, yields 404).
 *
 * The request body carries the conversion target (`openapi` today) and optional user-supplied
 * defaults (info title/version, servers) that close cheap gaps before committing. The `dryRun` flag
 * is forwarded both as a query param (authoritative) and in the body, so the REST layer can honour
 * whichever it reads.
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
    Authorization: `Bearer ${encodedToken}`,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const tenantId = user.current_tenant_id;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }
    const tenant = await getTenantById(tenantId);
    if (!tenant?.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }
    const { itemId } = await params;

    // The body carries { target, dryRun, defaults }; tolerate an empty/invalid body (defaults to a
    // dry-run so a malformed request never silently commits a conversion).
    const body = (await request.json().catch(() => null)) as
      | { target?: string; dryRun?: boolean; defaults?: unknown }
      | null;
    // The query param is authoritative for the side-effect decision.
    const dryRunParam = request.nextUrl.searchParams.get('dryRun');
    const dryRun = dryRunParam !== null ? dryRunParam !== 'false' : body?.dryRun !== false;

    const url =
      `${REST_API_BASE_URL}/catalog/${encodeURIComponent(tenant.slug)}` +
      `/${encodeURIComponent(itemId)}/convert?dryRun=${dryRun ? 'true' : 'false'}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: createAuthHeaders(user),
      body: JSON.stringify({
        target: body?.target ?? 'openapi',
        dryRun,
        defaults: body?.defaults,
      }),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return NextResponse.json(
        { success: false, error: text || 'Invalid JSON from REST API' },
        { status: response.status || 500 }
      );
    }
    if (!response.ok) {
      return NextResponse.json(
        {
          success: false,
          ...(typeof data === 'object' && data !== null ? (data as object) : { detail: data }),
        },
        { status: response.status }
      );
    }
    return NextResponse.json({
      success: true,
      ...(typeof data === 'object' && data !== null ? (data as object) : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
