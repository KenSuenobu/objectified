import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/export/preview-manifest — structural manifest of the emitted artifact
 * (IXH-4.1, #5109).
 *
 * Proxies REST `POST /v1/export/{tenant_slug}/preview-manifest`, which emits the chosen
 * target read-only and describes the artifact structurally: every canonical entity with
 * its stable canonical key, per-entity fidelity status/reason (drop reasons stated for
 * entities the artifact does not carry), and its location in the bundle (file, line,
 * pointer). Drives the Export Studio's artifact explorer tree and its two-way
 * entity ↔ code selection. Entities are cursor-paginated; the manifest is deterministic
 * per (revision, target, options) and cached server-side, so paging re-emits nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Missing request body' },
        { status: 400 },
      );
    }

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/export/${ctx.tenantSlug}/preview-manifest`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error loading the export preview manifest:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
