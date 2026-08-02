/**
 * Shared plumbing for the /api/schemas/suites/* proxy routes (IXH-5.7, #5119).
 *
 * The suite routes forward to REST `/v1/tenants/{tenant}/schema-suites[...]` — CRUD, runs,
 * history, and the corpus export/import. One helper carries the shared concerns so every route
 * stays thin and identical in behavior:
 *
 *  - **Detail passthrough** — addressing and validation faults carry a structured or string
 *    `detail` the panel surfaces verbatim (grammar help, bound violations, 409 name
 *    conflicts), so the REST body passes through with its status, exactly like the
 *    {@link import('./schema-bench-proxy').forwardSchemaRequest | Test Bench proxy}.
 *  - **Id encoding** — suite and run ids are single path segments, encoded as such. Schema
 *    *references* never appear in these paths (they travel in bodies or the `ref` query
 *    parameter), so no segment-preserving encoding is needed here.
 */

import { NextResponse } from 'next/server';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';
import type { SessionUser } from '@lib/primitives-api-proxy';

/**
 * Forward a request to a REST schema-suites endpoint and pass the response through.
 *
 * @param user - The authenticated session user (JWT minted from it).
 * @param tenantSlug - The caller's tenant slug.
 * @param method - The HTTP method to use against REST.
 * @param subpath - The path after `/schema-suites` (already encoded; `''` for the collection).
 * @param options.body - JSON body for write methods.
 * @param options.query - Query parameters appended to the REST URL.
 * @returns The proxied NextResponse (`{ success, … }` envelope, REST status preserved).
 */
export async function forwardSuiteRequest(
  user: SessionUser,
  tenantSlug: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  subpath: string,
  options?: { body?: unknown; query?: Record<string, string> }
): Promise<NextResponse> {
  const url = new URL(
    `${REST_API_BASE_URL}/tenants/${encodeURIComponent(tenantSlug)}/schema-suites${subpath}`
  );
  for (const [key, value] of Object.entries(options?.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: createRestAuthHeaders(user),
    cache: 'no-store',
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 204) {
    return NextResponse.json({ success: true }, { status: 200 });
  }

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return NextResponse.json(
      { success: false, error: text || 'Invalid JSON from REST API' },
      { status: response.status || 500 }
    );
  }

  // List endpoints return a bare array; wrap it so the envelope shape stays uniform.
  if (Array.isArray(data)) {
    return NextResponse.json({ success: response.ok, items: data }, { status: response.status });
  }
  const payload = typeof data === 'object' && data !== null ? (data as object) : { detail: data };
  return NextResponse.json({ success: response.ok, ...payload }, { status: response.status });
}

/** A validated single-segment id, or an error message when it is unusable. */
export function normalizeId(raw: unknown): { id: string } | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('/')) {
    return { error: 'A valid identifier is required.' };
  }
  return { id: encodeURIComponent(raw.trim()) };
}
