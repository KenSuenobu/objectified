import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedTenantContext,
  proxyRestGet,
  proxyRestPost,
} from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/export/mock — start an ephemeral mock of an emitted export artifact (MFX-44.5, #4371).
 *
 * Proxies REST `POST /v1/export/{tenant_slug}/mock`, which re-emits the source revision for the
 * requested `(target, options)`, freezes the resulting OpenAPI document into a short-lived,
 * tenant-scoped mock instance, and returns its live base URL. The mock is served by the existing
 * Mock Server data plane and auto-tears-down at its TTL.
 *
 * The body carries the same coordinates `/api/export/verify` and `/api/export/roundtrip` take
 * (`artifact`, `version`, `target`, `options`) plus an optional `ttlMinutes` — the emitted
 * document itself is never uploaded, so the mock provably serves what the revision emits.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Missing request body' }, { status: 400 });
    }

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error starting export mock:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * GET /api/export/mock — the workspace's live test-drive mocks (MFX-44.5, #4371).
 *
 * Proxies REST `GET /v1/export/{tenant_slug}/mock`. Expired instances and hosted mocks
 * (provisioned from a published version) are omitted upstream, so this is exactly the set the
 * per-tenant concurrency cap is measured against — which is what lets the panel explain a
 * refused start instead of just reporting it.
 */
export async function GET() {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, instances: data }, { status });
  } catch (error) {
    console.error('Error listing export mocks:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
