/**
 * GET  /api/schemas/suites/[suiteId]/runs — run history, newest first (IXH-5.7, #5119)
 * POST /api/schemas/suites/[suiteId]/runs — execute the suite against a revision
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSuiteRequest, normalizeId } from '@lib/schema-suite-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ suiteId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const suite = normalizeId((await params).suiteId);
    if ('error' in suite) {
      return NextResponse.json({ success: false, error: suite.error }, { status: 400 });
    }
    const query: Record<string, string> = {};
    const limit = request.nextUrl.searchParams.get('limit');
    const offset = request.nextUrl.searchParams.get('offset');
    if (limit !== null) query.limit = limit;
    if (offset !== null) query.offset = offset;
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'GET', `/${suite.id}/runs`, {
      query,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const suite = normalizeId((await params).suiteId);
    if ('error' in suite) {
      return NextResponse.json({ success: false, error: suite.error }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const forwarded: Record<string, unknown> = {};
    if (typeof body.version === 'string') forwarded.version = body.version;
    if (typeof body.trigger === 'string') forwarded.trigger = body.trigger;
    if (typeof body.max_findings === 'number') forwarded.max_findings = body.max_findings;
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'POST', `/${suite.id}/runs`, {
      body: forwarded,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
