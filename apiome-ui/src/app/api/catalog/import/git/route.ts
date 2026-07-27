import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestPost } from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * POST /api/catalog/import/git — fetch a git repository selection as an importable fileset
 * (MFI-29.3).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/import/git/fileset`. The request body is the REST
 * `GitFilesetRequest` (`{ repo_url, ref?, path?, root?, repository_id?, linked_account_id?,
 * include_document? }`) and the response carries the selected files packed as an archive
 * (`document_base64`), the resolved `archive_root`, the member list, the detection verdict, and
 * the `git_source` provenance to echo back in `options.git_source` when starting the import.
 *
 * Nothing is persisted here: the wizard then runs the normal pre-flight → `POST /api/catalog/import`
 * flow with those bytes, exactly as it does for an uploaded archive. Credentials are resolved
 * server-side from stored linked accounts; no token is ever sent from the browser.
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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/import/git/fileset`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error fetching git import fileset:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
