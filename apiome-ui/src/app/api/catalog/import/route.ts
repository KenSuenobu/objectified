import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedTenantContext,
  proxyRestGet,
  proxyRestPost,
} from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/catalog/import — list paginated spec-import jobs (IXH-6.3, #5122).
 *
 * Proxies REST `GET /v1/tenants/{tenant}/imports` with limit/offset/state/date query params.
 *
 * POST /api/catalog/import — start a catalog store-raw import (MFI-23.7).
 *
 * Proxies REST `POST /v1/tenants/{tenant}/imports` to run a non-OpenAPI source through the
 * import-source adapter pipeline, which persists a **catalog item** and keeps the original source
 * verbatim for later conversion (it does NOT convert to OpenAPI at import time). The request body is
 * the REST `SpecImportStartJsonRequest`: `{ metadata: { source_kind, project, version, options },
 * document_base64, filename }`. Returns the started job (`{ job_id, ... }`) for the client to poll.
 */

function forwardListQuery(request: NextRequest): string {
  const params = new URLSearchParams();
  for (const key of ['limit', 'offset', 'state', 'created_after', 'created_before'] as const) {
    const value = request.nextUrl.searchParams.get(key);
    if (value != null && value !== '') {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { data, error, status } = await proxyRestGet(
      ctx.user,
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/imports${forwardListQuery(request)}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error listing catalog import jobs:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

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
      `/tenants/${encodeURIComponent(ctx.tenantSlug)}/imports`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error starting catalog import:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
