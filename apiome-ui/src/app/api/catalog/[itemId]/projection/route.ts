import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/[itemId]/projection — one bounded page of a catalog item's conversion
 * projection manifest (CPDO-3.1, #4801).
 *
 * Proxies REST `POST /v1/catalog/{tenantSlug}/{itemId}/projection` (CPDO-1.3, #4800), which
 * rebuilds the deterministic source → OpenAPI projection manifest for the item's latest
 * revision and returns the snapshot summary plus one cursor-paginated page of edges. Strictly
 * read-only despite the POST verb — the body carries the gap-filling `defaults` that fold into
 * the snapshot hash, plus the page window (`scope` / `cursor` / `limit`). Nothing is persisted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { itemId } = await params;

    // Tolerate an empty body — the REST request model defaults every field.
    const body = (await request.json().catch(() => null)) ?? {};

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/catalog/${encodeURIComponent(ctx.tenantSlug)}/${encodeURIComponent(itemId)}/projection`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error fetching conversion projection:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
