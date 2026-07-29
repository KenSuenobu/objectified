import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/catalog/[itemId]/conversions/[provenanceId]/evidence — one page of the *stored*
 * evidence snapshot a historical conversion was approved with (CPDO-3.3, #4803).
 *
 * Proxies REST `GET /v1/catalog/{tenantSlug}/{itemId}/conversions/{provenanceId}/evidence`,
 * forwarding the page window (`scope` / `cursor` / `limit`). The REST side serves the
 * content-addressed snapshot — never a rebuild — and degrades to an explicit HTTP 200 state when
 * no snapshot can be served; it is gated on `imports:view`, and a 403 passes through untouched.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string; provenanceId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { itemId, provenanceId } = await params;

    const query = new URLSearchParams();
    for (const key of ['scope', 'cursor', 'limit'] as const) {
      const value = request.nextUrl.searchParams.get(key);
      if (value !== null && value !== '') query.set(key, value);
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/catalog/${encodeURIComponent(ctx.tenantSlug)}/${encodeURIComponent(itemId)}` +
        `/conversions/${encodeURIComponent(provenanceId)}/evidence${suffix}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error fetching conversion evidence snapshot:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
