import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/analysis-metrics — privacy-safe catalog analysis telemetry (CPDO-4.2).
 *
 * Proxies REST `POST /v1/catalog/{tenant_slug}/analysis-metrics`. Payload is a
 * strict whitelist of kinds, controlled surface names, and integer/duration
 * fields — never node names, values, or source content.
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
      `/catalog/${ctx.tenantSlug}/analysis-metrics`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error recording catalog analysis metric:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
