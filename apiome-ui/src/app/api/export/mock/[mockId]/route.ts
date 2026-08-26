import { NextResponse } from 'next/server';
import {
  getAuthenticatedTenantContext,
  proxyRestDelete,
  proxyRestGet,
} from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/export/mock/{mockId} — poll one test-drive mock (MFX-44.5, #4371).
 *
 * Proxies REST `GET /v1/export/{tenant_slug}/mock/{mock_id}`, which returns the instance with a
 * freshly computed `expiresInSeconds` and request count. The countdown is computed upstream on
 * purpose: a mock's remaining life must not depend on the viewer's clock.
 *
 * An expired instance comes back with `status: "expired"` rather than as an error — the panel
 * shows it as expired instead of having to interpret a failure.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mockId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { mockId } = await params;
    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock/${encodeURIComponent(mockId)}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error polling export mock:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/export/mock/{mockId} — stop a test-drive mock now (MFX-44.5, #4371).
 *
 * Proxies REST `DELETE /v1/export/{tenant_slug}/mock/{mock_id}` (204). The base URL stops
 * resolving immediately, the retained request log is discarded, and the workspace's concurrency
 * budget is freed — the explicit half of the auto-teardown TTL.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ mockId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { mockId } = await params;
    const { error, status } = await proxyRestDelete(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock/${encodeURIComponent(mockId)}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Error stopping export mock:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
