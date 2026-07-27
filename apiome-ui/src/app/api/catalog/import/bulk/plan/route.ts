import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/import/bulk/plan — partition one payload into the independent specs it
 * holds (MFI-29.5).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/bulk/plan`. The request body is the REST
 * `BulkImportPlanRequest` (`{ document_base64 | git, filename?, include_documents? }`) and the
 * response describes each independent spec — root document, the sibling files it compiles,
 * the detected adapter, the predicted destination, and a suggested catalog name and slug —
 * plus the files that belong to no item and a counted summary.
 *
 * Nothing is persisted and no job is created: this is what the wizard renders before the user
 * decides to import the batch.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/bulk/plan`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error planning bulk import:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
