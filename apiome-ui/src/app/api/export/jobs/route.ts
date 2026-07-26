import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthenticatedTenantContext,
  proxyRestGet,
  proxyRestPost,
} from '@lib/primitives-api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/export/jobs — list paginated export jobs (IXH-6.3, #5122).
 *
 * Proxies REST `GET /v1/export/{tenant_slug}/jobs` with limit/offset/state/date query params.
 * UI consumers must use this instead of fetching an unbounded history.
 *
 * POST /api/export/jobs — start an asynchronous export job (MFX-46.2, #4380).
 *
 * Proxies REST `POST /v1/export/{tenant_slug}/jobs` (MFX-3.1), which runs the same emit → fidelity
 * → validate → package pipeline as `POST …/document` but **asynchronously**: it returns a 202 with
 * `{ job_id, status_path }`, and the client polls `GET /api/export/jobs/{jobId}` for staged
 * progress until a terminal state. The Studio's Generate phase uses this (not the synchronous
 * document endpoint) so it can surface each stage and recover per-stage failures.
 *
 * The request body matches the synchronous emit — `{ artifact, version?, target, options?,
 * confirm?, dry_run? }` — and is forwarded verbatim. FastAPI `{detail}` errors are normalized to
 * the `{ success, error }` envelope the client hooks expect.
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
      `/export/${ctx.tenantSlug}/jobs${forwardListQuery(request)}`,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error listing export jobs:', error);
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
      return NextResponse.json({ success: false, error: 'Missing request body' }, { status: 400 });
    }

    const { data, error, status } = await proxyRestPost(
      ctx.user,
      `/export/${ctx.tenantSlug}/jobs`,
      body,
    );

    if (error) {
      return NextResponse.json({ success: false, error }, { status });
    }

    return NextResponse.json({ success: true, ...(data as Record<string, unknown>) }, { status });
  } catch (error) {
    console.error('Error starting export job:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
