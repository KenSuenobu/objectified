/**
 * Shared forwarding for the `/api/repositories/webhook-ip-allowlist/*` proxy routes
 * (REPO-7.6, #2804).
 *
 * Four handlers across two route files talk to the same REST surface with the same auth and
 * the same error contract, so the forwarding lives here once rather than four times.
 *
 * Note what is deliberately *not* here: the tenant-administrator check for the mutations.
 * That lives in REST, which owns the role. Duplicating it in the proxy would create a second
 * place to get it wrong — and the one an attacker can skip entirely by calling REST directly.
 */

import { NextResponse } from 'next/server';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';
import {
  getAuthenticatedTenantContext,
  type SessionUser,
} from '@lib/primitives-api-proxy';
import { restErrorMessage } from '@lib/rest-error-message';

/** Path of the REST surface, relative to the tenant. */
const BASE = 'repository-webhook-ip-allowlist';

/**
 * Resolve the caller's tenant, or the response explaining why we cannot.
 *
 * @returns The session user and tenant slug, or a ready-to-return error response.
 */
export async function resolveAllowlistTenant(): Promise<
  { user: SessionUser; slug: string } | { error: NextResponse }
> {
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
 * Build the REST URL for one allowlist path.
 *
 * @param slug - Tenant slug.
 * @param suffix - Path below the allowlist root, e.g. `/entries`. Empty for the root itself.
 */
export function allowlistUrl(slug: string, suffix = ''): string {
  return `${REST_API_BASE_URL}/tenants/${encodeURIComponent(slug)}/${BASE}${suffix}`;
}

/**
 * Forward one request to REST and normalise its answer.
 *
 * REST's status is passed through rather than collapsed, because the panel has to tell its
 * failures apart: 403 means "you are not an administrator", 400 means "that is not a CIDR",
 * and 404 means the entry is already gone. A success is recognised by the presence of
 * `providers` — every allowlist response carries it, including the ones mutations return.
 *
 * @param url - The REST URL to call.
 * @param init - Method, the authenticated user, and an optional JSON body.
 * @returns The response to hand back to the browser.
 */
export async function forwardAllowlistRequest(
  url: string,
  init: { method: string; user: SessionUser; body?: unknown }
): Promise<NextResponse> {
  try {
    const rest = await fetch(url, {
      method: init.method,
      headers: {
        ...createRestAuthHeaders(init.user),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
    });
    const text = await rest.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (rest.ok && parsed && typeof parsed === 'object' && 'providers' in parsed) {
      return NextResponse.json(parsed);
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
