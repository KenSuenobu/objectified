/**
 * Shared plumbing for the /api/schemas/* Test Bench proxy routes (IXH-5.3, #5115).
 *
 * The three routes (targets / validate / synthesize) all forward a **path-shaped schema
 * reference** (`project/petstore/1.0.0/Pet`) to the REST schema endpoints (IXH-5.1/5.2 and the
 * 5.3 targets listing). Two concerns live here so the routes stay thin and identical in
 * behavior:
 *
 *  - **Reference encoding** — the reference's own `/` separators are path structure and must
 *    survive, while each segment must still be escaped, so the reference is encoded
 *    segment-by-segment ({@link encodeSchemaRef}).
 *  - **Detail passthrough** — unlike the generic `proxyRest*` helpers, an addressing fault here
 *    carries a structured `detail` (`{ message, candidates }`) that the Test Bench shows the
 *    user ("did you mean…"), so the REST response body is passed through verbatim with its
 *    status rather than being collapsed to a string ({@link forwardSchemaRequest}).
 */

import { NextResponse } from 'next/server';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';
import type { SessionUser } from '@lib/primitives-api-proxy';

/** A validated, non-empty schema reference, or an error message when it is unusable. */
export function normalizeSchemaRef(raw: unknown): { ref: string } | { error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'A schema reference is required.' };
  }
  const ref = raw.trim().replace(/^\/+|\/+$/g, '');
  if (ref === '') {
    return { error: 'A schema reference is required.' };
  }
  return { ref };
}

/** Encode a path-shaped reference segment-by-segment so its `/` structure survives. */
export function encodeSchemaRef(ref: string): string {
  return ref
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Forward a Test Bench request to a REST schema endpoint and pass the response through.
 *
 * The REST body (including structured `detail` objects on 4xx) is returned verbatim under the
 * usual `{ success, … }` envelope, with the REST status preserved.
 *
 * @param user - The authenticated session user (JWT minted from it).
 * @param tenantSlug - The caller's tenant slug.
 * @param ref - The schema reference (already normalized, not yet encoded).
 * @param action - The endpoint tail: `targets` (GET) or `validate` / `synthesize` (POST).
 * @param body - The JSON body for POST actions; omitted for `targets`.
 * @param extra - Extra envelope fields merged into successful responses (e.g. `tenant_slug`,
 *   which the Test Bench needs to build a copy-as-curl command and the REST payload lacks).
 * @returns The proxied NextResponse.
 */
export async function forwardSchemaRequest(
  user: SessionUser,
  tenantSlug: string,
  ref: string,
  action: 'targets' | 'validate' | 'synthesize',
  body?: unknown,
  extra?: Record<string, unknown>
): Promise<NextResponse> {
  const url =
    `${REST_API_BASE_URL}/tenants/${encodeURIComponent(tenantSlug)}` +
    `/schemas/${encodeSchemaRef(ref)}/${action}`;
  const response = await fetch(url, {
    method: action === 'targets' ? 'GET' : 'POST',
    headers: createRestAuthHeaders(user),
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

  const payload = typeof data === 'object' && data !== null ? (data as object) : { detail: data };
  return NextResponse.json(
    { success: response.ok, ...(response.ok ? extra : undefined), ...payload },
    { status: response.status }
  );
}
