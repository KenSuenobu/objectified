/**
 * GET  /api/schemas/suites?ref=…  — list saved schema test suites (IXH-5.7, #5119)
 * POST /api/schemas/suites        — create a suite
 *
 * Proxies to REST `/v1/tenants/{tenant}/schema-suites`. Listing rows each carry a
 * `latest_run` summary (including the `regression` flag the detail surfaces badge on).
 * Only the known request fields are forwarded (the REST models are `extra="forbid"`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { normalizeSchemaRef } from '@lib/schema-bench-proxy';
import { forwardSuiteRequest } from '@lib/schema-suite-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const rawRef = request.nextUrl.searchParams.get('ref');
    const query: Record<string, string> = {};
    if (rawRef !== null) {
      const normalized = normalizeSchemaRef(rawRef);
      if ('error' in normalized) {
        return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
      }
      query.ref = normalized.ref;
    }
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'GET', '', { query });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'A JSON request body is required.' },
        { status: 400 }
      );
    }
    const normalized = normalizeSchemaRef(body.ref);
    if ('error' in normalized) {
      return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
    }
    const forwarded: Record<string, unknown> = { name: body.name, ref: normalized.ref };
    if (typeof body.description === 'string') forwarded.description = body.description;
    if (Array.isArray(body.payloads)) forwarded.payloads = body.payloads;
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'POST', '', { body: forwarded });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
