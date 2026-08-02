import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/export/roundtrip — on-demand round-trip comparison (IXH-4.4, #5112).
 *
 * Proxies REST `POST /v1/export/{tenant_slug}/roundtrip`, which emits the chosen target in a
 * temporary buffer, re-imports the emitted artifact through the matching import adapter, diffs
 * the re-imported canonical model against the source revision, and reconciles every difference
 * against the fidelity report — the same loop the IXH-1.7 conformance matrix runs in CI.
 * Differences the report explains come back `matched` (expected loss); `unexplained`
 * differences and `overclaims` flag a fidelity bug worth reporting. When no import adapter can
 * re-ingest the emit format the comparison is skipped with an explanation
 * (`status: unsupported`). The run is explicit and bounded — the Studio's action posts here;
 * nothing runs implicitly — and the server persists nothing.
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
      `/export/${ctx.tenantSlug}/roundtrip`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error running the export round-trip comparison:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
