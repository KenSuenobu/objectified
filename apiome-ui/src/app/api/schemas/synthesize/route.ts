/**
 * POST /api/schemas/synthesize
 * Proxies to REST POST /v1/tenants/{tenantSlug}/schemas/{ref}/synthesize (IXH-5.2, used by the
 * IXH-5.3 Test Bench).
 *
 * Body: `{ ref, seed?, include_minimal?, include_full?, include_branches?, include_mutants?,
 * mutation_kinds?, max_mutants?, max_branch_instances? }`. Only the known request fields are
 * forwarded (the REST model is `extra="forbid"`); everything returned is labelled synthetic by
 * the REST layer and the labels pass through untouched.
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

    // Whitelist the IXH-5.2 request fields; anything else would be rejected server-side.
    const forwarded: Record<string, unknown> = {};
    if (typeof body.seed === 'number') forwarded.seed = body.seed;
    for (const flag of [
      'include_minimal',
      'include_full',
      'include_branches',
      'include_mutants',
    ] as const) {
      if (typeof body[flag] === 'boolean') forwarded[flag] = body[flag];
    }
    if (Array.isArray(body.mutation_kinds)) forwarded.mutation_kinds = body.mutation_kinds;
    if (typeof body.max_mutants === 'number') forwarded.max_mutants = body.max_mutants;
    if (typeof body.max_branch_instances === 'number') {
      forwarded.max_branch_instances = body.max_branch_instances;
    }

    return await forwardSchemaRequest(
      ctx.user,
      ctx.tenantSlug,
      normalized.ref,
      'synthesize',
      forwarded
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
