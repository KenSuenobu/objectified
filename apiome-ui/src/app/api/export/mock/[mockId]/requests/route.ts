import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/** Largest page the request-log panel may ask for, matching the REST route's own ceiling. */
const MAX_LIMIT = 500;

/** What the panel asks for when the caller names no limit. */
const DEFAULT_LIMIT = 50;

/**
 * GET /api/export/mock/{mockId}/requests — a test-drive mock's request log (MFX-44.5, #4371).
 *
 * Proxies REST `GET /v1/export/{tenant_slug}/mock/{mock_id}/requests`: the requests the mock
 * served, newest first, with the status, whether an operation matched, the scenario in force, and
 * whether the body agreed with the response schema. The log is a bounded in-memory ring buffer on
 * the serving replica — a live view of a mock that expires in minutes, not an audit trail — so the
 * response also reports the buffer's capacity and whether older traffic has already rolled off.
 *
 * `limit` is clamped here as well as upstream so a hand-edited query string cannot ask the REST
 * spine for an unbounded page.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ mockId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { mockId } = await params;
    const requested = Number(request.nextUrl.searchParams.get('limit'));
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock/${encodeURIComponent(mockId)}/requests?limit=${limit}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error reading export mock request log:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
