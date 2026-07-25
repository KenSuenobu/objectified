import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/import/preview-manifest — same-origin proxy for the import preview manifest
 * (IXH-3.1, #5103).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/preview-manifest`, which extends the pre-flight
 * into a full entity manifest for a *candidate* document without writing anything: the canonical
 * entity tree with source locations, per-entity provenance, and the coverage ledger. The wizard's
 * quality step (IXH-3.2) renders it so the user sees what the import would create while cancelling
 * is still free.
 *
 * The request body is the REST `ImportPreviewManifestRequest` (the pre-flight fields plus optional
 * `cursor` / `page_size` for entity-tree pagination). A candidate that cannot be previewed is a
 * **200 with `ok: false` and `manifest: null`** — not an HTTP error — so the caller must read `ok`,
 * not just the status.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/preview-manifest`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error building import preview manifest:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
