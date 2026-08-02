/**
 * GET /api/schemas/suites/[suiteId]/runs/[runId] — one run with per-payload results and the
 * verdict diff against its baseline (IXH-5.7, #5119).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSuiteRequest, normalizeId } from '@lib/schema-suite-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ suiteId: string; runId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const resolved = await params;
    const suite = normalizeId(resolved.suiteId);
    const run = normalizeId(resolved.runId);
    if ('error' in suite || 'error' in run) {
      return NextResponse.json(
        { success: false, error: 'A valid identifier is required.' },
        { status: 400 }
      );
    }
    return await forwardSuiteRequest(
      ctx.user,
      ctx.tenantSlug,
      'GET',
      `/${suite.id}/runs/${run.id}`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
