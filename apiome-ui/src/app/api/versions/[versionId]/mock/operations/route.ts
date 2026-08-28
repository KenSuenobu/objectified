/**
 * API proxy for the version's mock-authoring catalogue (#5529, MSC-1.3).
 *
 * Proxies `GET /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/operations`, which answers
 * with the version's own operations (and their path/query/header parameters), the JSON Pointers an
 * explicit binding can target, the fixture names templates can read, and what the `path-params`
 * and `inferred` correlation passes would bind — the read-only preview the editor shows before an
 * author commits to a mode.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  resolveVersionMockContext,
  restErrorResponse,
  versionMockUrl,
} from '@lib/mock/versionMockProxy';

/**
 * GET /api/versions/[versionId]/mock/operations?projectId=...
 *
 * @returns `{ success, operations, fixtures }`.
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
      versionMockUrl(context.tenantSlug, projectId, versionId, 'mock/operations'),
      { method: 'GET', headers: context.headers }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return restErrorResponse(data, response.status, 'Failed to load this version’s operations');
    }

    return NextResponse.json({
      success: true,
      operations: data?.operations ?? [],
      fixtures: data?.fixtures ?? [],
    });
  } catch (error) {
    console.error('Error loading mock operations:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
