/**
 * GET /api/schemas/suites/[suiteId]/export — the suite as an IXH-1.1 corpus manifest envelope
 * `{ suite, manifest, files }` (IXH-5.7, #5119), consumable by `apiome schema test --suite`
 * once the files are materialized next to the manifest.
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
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'GET', `/${suite.id}/export`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
