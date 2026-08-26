import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedTenantContext, proxyRestGet } from '@lib/primitives-api-proxy';
import { REST_API_BASE_URL } from '@lib/rest-auth';
import { resolveMockRequestUrl } from '@lib/export-mock-request-url';

export const dynamic = 'force-dynamic';

/** Methods the try-it control may send. Mirrors what the Mock Server data plane routes. */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** Largest response body echoed back to the panel; anything longer is truncated for display. */
const MAX_BODY_CHARS = 64_000;

/** How long a single try-it request may take before it is abandoned. */
const TRY_TIMEOUT_MS = 15_000;

/** Response headers worth showing: the mock's own evidence about how it answered. */
const ECHOED_HEADERS = [
  'content-type',
  'x-mock-scenario',
  'x-mock-matched',
  'x-mock-operation',
  'x-mock-schema-valid',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'retry-after',
];

/**
 * POST /api/export/mock/{mockId}/try — send one request to a live test-drive mock (MFX-44.5, #4371).
 *
 * The "requests round-trip with schema-shaped responses" half of the ticket. The Mock Server data
 * plane (`/v1/mock/{mock_id}/…`) is deliberately unauthenticated and lives on the REST spine, which
 * the browser cannot be assumed to reach; this route is the same-origin bridge to it.
 *
 * Before forwarding, it proves the caller owns the instance by reading it through the authenticated
 * export surface — so this endpoint grants no reach the Studio does not already have, and cannot be
 * pointed at another tenant's mock. A mock that has since lapsed still forwards: the data plane's
 * own `410 Gone` is the honest answer, and echoing it is more useful than inventing one here.
 *
 * The response is returned as data (`status`, selected headers, body text) rather than replayed,
 * so the panel can render it beside the request log instead of navigating away from the Studio.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ mockId: string }> },
) {
  try {
    const ctx = await getAuthenticatedTenantContext();
    if (!ctx.ok) {
      return NextResponse.json({ success: false, error: ctx.error }, { status: ctx.status });
    }

    const { mockId } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ success: false, error: 'Missing request body' }, { status: 400 });
    }

    const method = String((body as { method?: unknown }).method ?? 'GET').toUpperCase();
    if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
      return NextResponse.json(
        { success: false, error: `Unsupported method ${method}.` },
        { status: 400 },
      );
    }

    const path = String((body as { path?: unknown }).path ?? '/');
    const scenario = (body as { scenario?: unknown }).scenario;

    // Ownership, through the authenticated surface. A mock this tenant does not own is a 404 here
    // exactly as it is upstream, so the bridge grants no reach the Studio lacks.
    const owned = await proxyRestGet(
      ctx.user,
      `/export/${encodeURIComponent(ctx.tenantSlug)}/mock/${encodeURIComponent(mockId)}`,
    );
    if (owned.error) {
      return NextResponse.json({ success: false, error: owned.error }, { status: owned.status });
    }

    const target = resolveMockRequestUrl(REST_API_BASE_URL, mockId, path);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (typeof scenario === 'string' && scenario.trim()) {
      headers['X-Mock-Scenario'] = scenario.trim();
    }

    const started = Date.now();
    const response = await fetch(target, {
      method,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
    });
    const text = await response.text();

    return NextResponse.json({
      success: true,
      request: { method, path, url: `${target.pathname}${target.search}` },
      status: response.status,
      durationMs: Date.now() - started,
      headers: Object.fromEntries(
        ECHOED_HEADERS.flatMap((name) => {
          const value = response.headers.get(name);
          return value === null ? [] : [[name, value] as const];
        }),
      ),
      body: text.slice(0, MAX_BODY_CHARS),
      truncated: text.length > MAX_BODY_CHARS,
    });
  } catch (error) {
    console.error('Error sending a request to an export mock:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
