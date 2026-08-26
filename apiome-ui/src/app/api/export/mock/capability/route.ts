import { NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/export/mock/capability — can this server mock an emitted artifact? (MFX-44.5, #4371)
 *
 * Proxies REST `GET /v1/export/{tenant_slug}/mock/capability`, which reports whether the Mock
 * Server engine is deployed and the export binding enabled, which target keys the engine can
 * serve, and the TTL / concurrency / rate bounds a provision will apply.
 *
 * This is the flag the Export Studio's Test-drive panel renders itself from: an unavailable
 * server means no panel (or a disabled one carrying the server's own reason), and the target
 * list keeps the "which formats can be mocked" decision on the server, where the emitter
 * registry lives — the UI asks, it never decides.
 */
export async function GET() {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock/capability`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error reading export mock capability:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
