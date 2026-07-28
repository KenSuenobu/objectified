import { NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/import/format-capabilities — the source-format capability & parsing-limit registry
 * (CPDO-2.4, #4796).
 *
 * Proxies REST `GET /v1/import/format-capabilities`, which returns the versioned registry: one
 * entry per registered import source (native hierarchy, source-location quality, value-visibility
 * ceiling, unsupported grammar, canonical-projection coverage, conversion-graph support — each
 * stamped with the analyzer key/version and underlying tool versions), plus the reviewed wording
 * for every way a detail can be absent.
 *
 * Static reference data — the same for every tenant and every catalog item — so the UI fetches it
 * once per page load and caches it by `version`. It is what lets a catalog screen say *why* a
 * detail is missing instead of collapsing a parser limit, a capability boundary, a redaction and a
 * genuinely uncaptured source into one "no details".
 */
export async function GET() {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { data, error, status } = await proxyRestGet(ctx.user, `/import/format-capabilities`);

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error fetching format capability registry:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
