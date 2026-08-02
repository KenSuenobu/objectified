/**
 * POST /api/schemas/suites/import — create a suite from an IXH-1.1 corpus manifest envelope
 * (IXH-5.7, #5119). The inverse of `/api/schemas/suites/[suiteId]/export`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext } from '@lib/primitives-api-proxy';
import { normalizeSchemaRef } from '@lib/schema-bench-proxy';
import { forwardSuiteRequest } from '@lib/schema-suite-proxy';

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
    const forwarded: Record<string, unknown> = {
      name: body.name,
      ref: normalized.ref,
      manifest: body.manifest,
      files: Array.isArray(body.files) ? body.files : [],
    };
    if (typeof body.description === 'string') forwarded.description = body.description;
    return await forwardSuiteRequest(ctx.user, ctx.tenantSlug, 'POST', '/import', {
      body: forwarded,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
