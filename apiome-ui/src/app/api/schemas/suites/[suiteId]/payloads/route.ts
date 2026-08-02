/**
 * PUT /api/schemas/suites/[suiteId]/payloads — replace a suite's payload set (IXH-5.7, #5119).
 * Replace-all semantics; the REST side bumps `suite_version`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSuiteRequest, normalizeId } from '@lib/schema-suite-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ suiteId: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
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
    if (!body || !Array.isArray(body.payloads)) {
      return NextResponse.json(
        { success: false, error: 'A JSON body with a `payloads` array is required.' },
        { status: 400 }
      );
    }
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'PUT', `/${suite.id}/payloads`, {
      body: { payloads: body.payloads },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
