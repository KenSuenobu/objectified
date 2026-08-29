/**
 * API proxy for the version's mock response-correlation settings (#5527 MSC-1.1, #5529 MSC-1.3).
 *
 * Proxies the ADE correlation editor to REST with JWT authentication:
 * - `GET  /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/correlation`
 * - `PUT  /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/correlation`
 *
 * Save-time validation failures (HTTP 422) come back as `{ success: false, error, errors }` so the
 * editor can attach each message to the binding row that caused it.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  resolveVersionMockContext,
  restErrorResponse,
  versionMockUrl,
} from '@lib/mock/versionMockProxy';

/**
 * GET /api/versions/[versionId]/mock/correlation?projectId=...
 *
 * @returns `{ success, correlation }`; `correlation` is `null` when the version has none.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ success: false, error: 'Project ID is required' }, { status: 400 });
    }

    const context = await resolveVersionMockContext();
    if (!context.ok) return context.response;

    const response = await fetch(
      versionMockUrl(context.tenantSlug, projectId, versionId, 'mock/correlation'),
      { method: 'GET', headers: context.headers }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return restErrorResponse(data, response.status, 'Failed to load response correlation');
    }

    return NextResponse.json({ success: true, correlation: data?.correlation ?? null });
  } catch (error) {
    console.error('Error loading mock correlation:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * PUT /api/versions/[versionId]/mock/correlation
 *
 * Body: `{ projectId, correlation }` — sending `null` clears the block (correlation reverts to
 * off).
 *
 * @returns `{ success, correlation }`, or `{ success: false, error, errors }` on a REST 422.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
    const body = (await request.json()) as { projectId?: string; correlation?: unknown };

    if (!body.projectId) {
      return NextResponse.json({ success: false, error: 'Project ID is required' }, { status: 400 });
    }
    const { correlation } = body;
    if (
      correlation !== null &&
      correlation !== undefined &&
      (typeof correlation !== 'object' || Array.isArray(correlation))
    ) {
      return NextResponse.json(
        { success: false, error: '`correlation` must be an object or null' },
        { status: 400 }
      );
    }

    const context = await resolveVersionMockContext();
    if (!context.ok) return context.response;

    const response = await fetch(
      versionMockUrl(context.tenantSlug, body.projectId, versionId, 'mock/correlation'),
      {
        method: 'PUT',
        headers: context.headers,
        body: JSON.stringify({ correlation: correlation ?? null }),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return restErrorResponse(data, response.status, 'Failed to save response correlation');
    }

    return NextResponse.json({ success: true, correlation: data?.correlation ?? null });
  } catch (error) {
    console.error('Error saving mock correlation:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
