import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/import/bulk — start one import job per independent spec in a payload
 * (MFI-29.5).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/bulk`. The server re-plans the payload and
 * schedules an ordinary import job per selected item, so every spec runs the same pipeline —
 * quality gate, adapter, §0.2 routing — it would run on its own.
 *
 * The response is the per-item start result: `accepted` rows carry a `job_id`, `failed` rows
 * carry a taxonomy-coded reason. A partial failure is normal and never aborts the batch, so
 * the wizard renders the rows rather than treating one failure as an error.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/bulk`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error starting bulk import:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
