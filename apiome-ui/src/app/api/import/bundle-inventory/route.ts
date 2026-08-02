import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/import/bundle-inventory — same-origin proxy for the multi-file / archive intake
 * explorer (IXH-3.5, #5107).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/bundle-inventory`, which describes a *bundle*
 * candidate file by file without writing anything: each file's role (entry point, dependency,
 * unreferenced, ignored — with the reason — or unreadable), its verdict and any parse diagnostic
 * naming it, its resolved import/include edges, and the canonical entities it appears to contribute.
 * The response also carries every unresolved reference with the search paths that were tried, and
 * the ranked entry-point candidates the wizard's picker offers.
 *
 * The request body is the REST `ImportBundleInventoryRequest` (the pre-flight fields — including a
 * pinned `archive_root` — plus optional `cursor` / `page_size`). Two non-error verdicts the caller
 * must read rather than infer from the status: a payload that is not an archive comes back **200
 * with `kind: 'single-document'`**, and an archive that could not be unpacked comes back **200 with
 * `ok: false`** and the intake-taxonomy `error`.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/bundle-inventory`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error building import bundle inventory:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
