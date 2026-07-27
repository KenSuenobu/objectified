import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/import/bulk/status — roll up one batch's jobs into a per-item result list
 * (MFI-29.5).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/bulk/status`. The request body is the
 * `(key, job_id)` pairs the submit call returned; the response reports each item's state, its
 * authoritative destination and created item once it completes, and its taxonomy-coded error
 * when it fails — plus counts and a `done` flag the wizard polls on.
 *
 * One roll-up call replaces N per-job polls; each row is still exactly what
 * `GET …/imports/{job_id}` returns, which stays the source of truth.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/bulk/status`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error polling bulk import status:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
