import { NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/projects/[projectId]/conversions — the conversions that produced a Project
 * (CPDO-3.3, #4803).
 *
 * Proxies REST `GET /v1/projects/{tenantSlug}/{projectId}/conversions`: newest-first
 * provenance rows targeting this Project, each linking a target revision back to the source
 * catalog item it was converted from. Empty for projects that were never a conversion target.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }
    const { projectId } = await params;

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/projects/${encodeURIComponent(ctx.tenantSlug)}/${encodeURIComponent(projectId)}/conversions`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) });
  } catch (error) {
    console.error('Error fetching project conversion history:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
