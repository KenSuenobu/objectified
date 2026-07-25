import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/export/preflight — same-origin proxy for the export pre-flight report (IXH-2.4, #5099).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/export/preflight`, which ranks every export target for
 * one source revision *before* a job exists: the source's lint grade under the tenant's style
 * guide, each target's projected fidelity envelope, its capability verdict, the tenant export
 * quality-policy verdict, and a composite readiness score with a one-line rationale. Nothing is
 * emitted and nothing is persisted.
 *
 * The request body is the REST `ExportPreflightRequest` (`artifact`, plus optional `version` /
 * `targets` / `include_findings`). Drives the ExportTargetGrid's readiness ordering.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/export/preflight`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error pre-flighting export:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
