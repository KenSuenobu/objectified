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
 *
 * The body may carry BLK-1.3's `overrides`, `plan_fingerprint` and `dry_run`; they pass
 * through untouched. A 409 `TARGET_PLAN_STALE` refusal is returned with its `detail` intact,
 * because its per-item `drift` list is what the reader needs to see.
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

    const { data, error, status, detail } = await proxyRestPost(
      ctx.user,
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/bulk`,
      body,
    );

    if (error) {
      // The stale-plan refusal (BLK-1.3) names, per item, what drifted since the plan was
      // reviewed. That list is the whole point of the refusal, so the typed `detail` is
      // handed through beside the message rather than flattened into it.
      return NextResponse.json({ success: false, error, detail }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error starting bulk import:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
