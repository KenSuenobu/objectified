/**
 * API Proxy for a Catalog Item's Native Payload Analysis (CPDO-2.1, #4797).
 *
 * Proxies REST `GET /v1/catalog/{tenant_slug}/{item_id}/analysis` — the immutable, revision-scoped
 * record CPDO-1.1 (#4794) defined: the native structure of the imported source in the analyzer's own
 * vocabulary, its source locations, its analyzer's warnings and capability declaration, and the
 * redaction metadata stating what was withheld.
 *
 * **Authorization is the REST endpoint's, not this route's.** The catalog detail read embeds only
 * the tree-free *summary*, readable by anyone who can read the item; the tree is a structural
 * description of the payload itself and is gated on `imports:view`. This proxy therefore forwards
 * the caller's identity and passes the upstream status through **unchanged** — a 403 stays a 403,
 * so the Format details tab can say "you may not read this" rather than the untrue "there is no
 * analysis". A 404 likewise stays a 404 (the item is not a catalog item, or not in this tenant).
 *
 * `?valueVisibility=none|structural|full` is forwarded when present: it can only *narrow* what the
 * stored record carries, never widen it, and an unrecognised level is the upstream's 422.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/catalog/[itemId]/analysis — the item's native payload analysis record.
 *
 * @param request The incoming request; its `valueVisibility` query param is forwarded.
 * @param params Route params carrying the catalog item id.
 * @returns `{ success: true, record }` on success, or `{ success: false, error }` with the
 *   upstream status (401/403/404/422/5xx) preserved.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const { itemId } = await params;
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const visibility = request.nextUrl.searchParams.get('valueVisibility');
    const query = visibility ? `?valueVisibility=${encodeURIComponent(visibility)}` : '';
    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/catalog/${ctx.tenantSlug}/${encodeURIComponent(itemId)}/analysis${query}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, record: data });
  } catch (error) {
    console.error('Error fetching catalog payload analysis:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
