/**
 * POST /api/schemas/validate
 * Proxies to REST POST /v1/tenants/{tenantSlug}/schemas/{ref}/validate (IXH-5.1, used by the
 * IXH-5.3 Test Bench).
 *
 * Body: `{ ref, instance_text | instance, media_type?, max_findings?, assert_formats? }`.
 * Only the known request fields are forwarded (the REST model is `extra="forbid"`); the REST
 * response — findings, diagnostics, or a structured 4xx `detail` — passes through verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { forwardSchemaRequest, normalizeSchemaRef } from '@lib/schema-bench-proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'A JSON request body is required.' },
        { status: 400 }
      );
    }

    const normalized = normalizeSchemaRef(body.ref);
    if ('error' in normalized) {
      return NextResponse.json({ success: false, error: normalized.error }, { status: 400 });
    }

    // Whitelist the IXH-5.1 request fields; anything else would be rejected server-side.
    const forwarded: Record<string, unknown> = {};
    if ('instance' in body) forwarded.instance = body.instance;
    if (typeof body.instance_text === 'string') forwarded.instance_text = body.instance_text;
    if (typeof body.media_type === 'string') forwarded.media_type = body.media_type;
    if (typeof body.max_findings === 'number') forwarded.max_findings = body.max_findings;
    if (typeof body.assert_formats === 'boolean') forwarded.assert_formats = body.assert_formats;

    return await forwardSchemaRequest(
      ctx.user,
      ctx.tenantSlug,
      normalized.ref,
      'validate',
      forwarded
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
