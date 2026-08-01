/**
 * Shared forwarding for the `/api/repositories/{id}/conflict-policy*` proxy routes
 * (RAR-4.5, #3531).
 *
 * Three handlers across two route files talk to the same REST surface with the same auth,
 * the same repository-id guard and the same error contract, so the forwarding lives here
 * once rather than three times.
 *
 * One shaping decision is made here and nowhere else: REST nests its projection under
 * `conflictPolicy`, and the panel reads one flat object. Flattening at the boundary keeps
 * that envelope detail out of the component and out of every route file.
 */

import { NextResponse } from 'next/server';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';
import {
  getAuthenticatedTenantContext,
  type SessionUser,
} from '@lib/primitives-api-proxy';
import { restErrorMessage } from '@lib/rest-error-message';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the caller's tenant and validate the repository id, or explain why we cannot.
 *
 * @param repositoryId The repository id from the route params.
 * @returns The session user and tenant slug, or a ready-to-return error response.
 */
async function resolveConflictPolicyCaller(
  repositoryId: string
): Promise<{ user: SessionUser; slug: string } | { error: NextResponse }> {
  if (!repositoryId || !UUID_RE.test(repositoryId)) {
    return {
      error: NextResponse.json({ success: false, error: 'Invalid repository id' }, { status: 400 }),
    };
  }
  const context = await getAuthenticatedTenantContext();
  if (!context.ok) {
    return {
      error: NextResponse.json(
        { success: false, error: context.error },
        { status: context.status }
      ),
    };
  }
  return { user: context.user, slug: context.tenantSlug };
}

/**
 * Forward one conflict-policy request to REST and normalise its answer.
 *
 * REST's status is passed through rather than collapsed, because the panel has to tell its
 * failures apart: 400 means "that is not a policy", 404 means the repository is not this
 * tenant's. A success is recognised by the presence of `conflictPolicy` — the read and every
 * mutation return it — and is flattened into the response body.
 *
 * @param repositoryId The repository id from the route params.
 * @param method HTTP method to forward (`GET` reads, `PUT` writes).
 * @param suffix Sub-path under `/conflict-policy` (`''` for the repository policy,
 *   `'/file'` for a per-file override).
 * @param body Payload for a write; omitted on a read.
 * @returns The response to hand back to the browser.
 */
export async function forwardConflictPolicyRequest(
  repositoryId: string,
  method: 'GET' | 'PUT',
  suffix: '' | '/file' = '',
  body?: unknown
): Promise<NextResponse> {
  const resolved = await resolveConflictPolicyCaller(repositoryId);
  if ('error' in resolved) return resolved.error;
  const { user, slug } = resolved;

  const url =
    `${REST_API_BASE_URL}/tenants/${encodeURIComponent(slug)}` +
    `/repositories/${encodeURIComponent(repositoryId)}/conflict-policy${suffix}`;

  try {
    const rest = await fetch(url, {
      method,
      headers: {
        ...createRestAuthHeaders(user),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
    const text = await rest.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (rest.ok && parsed && typeof parsed === 'object' && 'conflictPolicy' in parsed) {
      const projection = (parsed as { conflictPolicy: Record<string, unknown> }).conflictPolicy;
      return NextResponse.json({ success: true, ...projection });
    }
    return NextResponse.json(
      { success: false, error: restErrorMessage(parsed) },
      { status: rest.status >= 400 ? rest.status : 502 }
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Repository API unavailable (apiome-rest not reachable).' },
      { status: 503 }
    );
  }
}

/**
 * Read and parse a JSON request body.
 *
 * @param request The incoming request.
 * @returns The parsed body, or the 400 response for malformed JSON.
 */
export async function readConflictPolicyBody(
  request: Request
): Promise<{ body: unknown } | { error: NextResponse }> {
  try {
    return { body: await request.json() };
  } catch {
    return {
      error: NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
}
