/**
 * GET    /api/schemas/suites/[suiteId] — one suite with its payloads (IXH-5.7, #5119)
 * PATCH  /api/schemas/suites/[suiteId] — rename / re-describe
 * DELETE /api/schemas/suites/[suiteId] — delete the suite and its history
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSuiteRequest, normalizeId } from '@lib/schema-suite-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ suiteId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const suite = normalizeId((await params).suiteId);
    if ('error' in suite) {
      return NextResponse.json({ success: false, error: suite.error }, { status: 400 });
    }
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'GET', `/${suite.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const suite = normalizeId((await params).suiteId);
    if ('error' in suite) {
      return NextResponse.json({ success: false, error: suite.error }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'A JSON request body is required.' },
        { status: 400 }
      );
    }
    const forwarded: Record<string, unknown> = {};
    if (typeof body.name === 'string') forwarded.name = body.name;
    if (typeof body.description === 'string') forwarded.description = body.description;
    if (typeof body.clear_description === 'boolean') {
      forwarded.clear_description = body.clear_description;
    }
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'PATCH', `/${suite.id}`, {
      body: forwarded,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const suite = normalizeId((await params).suiteId);
    if ('error' in suite) {
      return NextResponse.json({ success: false, error: suite.error }, { status: 400 });
    }
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'DELETE', `/${suite.id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
