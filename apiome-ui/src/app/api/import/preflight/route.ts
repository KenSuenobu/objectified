import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/import/preflight — same-origin proxy for the import pre-flight report (IXH-2.1, #5096).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/preflight`, which lints and ranks a *candidate*
 * document without writing anything: the wizard's quality step (IXH-2.2) calls this before the
 * commit so the user sees the grade, the ranked findings, and the policy verdict while cancelling
 * is still free.
 *
 * The request body is the REST `ImportPreflightRequest` (`document_base64`, plus optional
 * `source_kind` / `filename` / `content_type` / `url` / `input_kind` / `import_target`). A candidate
 * that cannot be imported is a **200 with `ok: false`** and a taxonomy error — not an HTTP error —
 * so the caller must read `ok`, not just the status.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
    }

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/preflight`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error pre-flighting import candidate:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
