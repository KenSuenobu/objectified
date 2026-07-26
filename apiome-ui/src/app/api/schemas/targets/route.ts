/**
 * GET /api/schemas/targets?ref={kind/artifact/version}
 * Proxies to REST GET /v1/tenants/{tenantSlug}/schemas/{ref}/targets (IXH-5.3, #5115).
 *
 * Lists everything one revision offers the Schema Test Bench: its named types and the
 * operation request/response bodies that resolve to a named type. `ref` is the IXH-5.1
 * path-shaped reference without a type segment (`project/petstore/1.0.0`,
 * `catalog/legacy-soap/latest`). Structured REST error details (message + candidates) pass
 * through so the bench can show "did you mean" guidance.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSchemaRequest, normalizeSchemaRef } from '@lib/schema-bench-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const normalized = normalizeSchemaRef(request.nextUrl.searchParams.get('ref'));
    if ('error' in normalized) {
      return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
    }

    // `tenant_slug` rides along so the bench can build a copy-as-curl command against the
    // REST endpoint (the client session only carries the tenant *id*).
    return await forwardSchemaRequest(ctx.user, ctx.tenantSlug, normalized.ref, 'targets', undefined, {
      tenant_slug: ctx.tenantSlug,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
