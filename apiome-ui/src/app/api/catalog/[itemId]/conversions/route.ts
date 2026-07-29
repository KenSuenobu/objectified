import { NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/catalog/[itemId]/conversions — a catalog item's conversion provenance history
 * (CPDO-3.3, #4803).
 *
 * Proxies REST `GET /v1/catalog/{tenantSlug}/{itemId}/conversions`: newest-first ledger rows with
 * the content-addressed snapshot id, the per-conversion source digest, and `currentSourceHash` so
 * the client can mark rows whose source has since changed as historic.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { itemId } = await params;

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/catalog/${encodeURIComponent(ctx.tenantSlug)}/${encodeURIComponent(itemId)}/conversions`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error fetching conversion history:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
