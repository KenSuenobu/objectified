/**
 * API proxy for the dry-run mock preview (#5528 MSC-1.2, #5529 MSC-1.3).
 *
 * Proxies `POST /v1/versions/{tenantSlug}/{projectId}/{versionId}/mock/preview`, which renders one
 * synthetic request against the version's mock — optionally against an **unsaved** `settings`
 * draft — and answers with the response plus the decision trace naming which layer produced it.
 *
 * The failure statuses are forwarded rather than collapsed: 503 (preview not configured on this
 * deployment), 429 (the per-version rate limit), 413 (body too large) and 422 (a draft that could
 * never be saved) each mean something different to an author, and the editor says so.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  resolveVersionMockContext,
  restErrorResponse,
  versionMockUrl,
} from '@lib/mock/versionMockProxy';

/**
 * POST /api/versions/[versionId]/mock/preview
 *
 * Body: `{ projectId, request, settings? }` — `request` is the synthetic request
 * (`{ method, path, headers, query, body, scenario, seed }`), `settings` an unsaved draft to render
 * against instead of the stored configuration.
 *
 * @returns `{ success, preview }` with the rendered response and its trace, or
 * `{ success: false, error, errors? }`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> }
) {
  try {
    const { versionId } = await params;
    const body = (await request.json()) as {
      projectId?: string;
      request?: unknown;
      settings?: unknown;
    };

    if (!body.projectId) {
      return NextResponse.json({ success: false, error: 'Project ID is required' }, { status: 400 });
    }
    if (!body.request || typeof body.request !== 'object' || Array.isArray(body.request)) {
      return NextResponse.json(
        { success: false, error: '`request` must be an object' },
        { status: 400 }
      );
    }

    const context = await resolveVersionMockContext();
    if (!context.ok) return context.response;

    const response = await fetch(
      versionMockUrl(context.tenantSlug, body.projectId, versionId, 'mock/preview'),
      {
        method: 'POST',
        headers: context.headers,
        body: JSON.stringify({
          request: body.request,
          ...(body.settings !== undefined && body.settings !== null
            ? { settings: body.settings }
            : {}),
        }),
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return restErrorResponse(data, response.status, 'Failed to render the mock preview');
    }

    return NextResponse.json({ success: true, preview: data });
  } catch (error) {
    console.error('Error rendering mock preview:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
