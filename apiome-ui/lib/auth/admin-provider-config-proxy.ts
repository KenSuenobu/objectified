/**
 * Server-side forwarders for the admin auth-provider config proxy (OLO-8.7, #4973).
 *
 * The settings screen cannot call apiome-rest directly (different origin; the signed
 * `admin_session` cookie lives on the UI domain), so its Next.js API routes
 * (`src/app/api/admin/auth-providers`) forward requests here. Each forwarder:
 *
 *   - targets the super-admin REST surface (OLO-8.4, `/v1/admin/auth-providers`) and presents
 *     the signed admin-session token via the `X-Admin-Session` header, which apiome-rest
 *     verifies against the same HMAC key (`admin_session.py`) — the proxy adds no authority of
 *     its own;
 *   - passes the upstream status and JSON body through verbatim, so the client sees the REST
 *     contract (including the structured 422 enable-guidance and 503 encryption errors) without
 *     re-interpretation;
 *   - never throws: an unreachable/misbehaving REST becomes a structured `502` result.
 *
 * After a successful write, {@link proxyUpdateAuthProvider} invalidates the in-process resolved
 * provider-config cache (OLO-8.5) — this proxy runs in the same Next.js process as the
 * per-request NextAuth resolution (OLO-8.6), so an admin's change is picked up by the very next
 * login instead of waiting out the cache TTL.
 *
 * Server-only: import from API routes / server code, never from a client component.
 */
import { REST_API_BASE_URL } from '../rest-auth';
import { invalidateProviderConfigCache } from './provider-config-resolver';
import type { AdminProviderUpdatePayload } from './admin-provider-config';

/** Outcome of a forwarded call: the HTTP status and parsed JSON body to relay to the client. */
export interface AdminProviderProxyResult {
  /** HTTP status to respond with (the upstream status, or `502` on transport failure). */
  status: number;
  /** JSON body to respond with (the upstream body, or a structured error object). */
  body: unknown;
}

/** Bound on each upstream call so a hung REST can never stall the admin screen indefinitely. */
const PROXY_TIMEOUT_MS = 10_000;

/** The one transport-failure shape this proxy emits (status `502`). */
function unreachableResult(): AdminProviderProxyResult {
  return {
    status: 502,
    body: {
      error: 'rest_unreachable',
      message:
        'Could not reach the configuration service (apiome-rest). Check that it is running and retry.',
    },
  };
}

/**
 * Forward one request to the REST admin auth-provider surface.
 *
 * @param path Path under `${REST_API_BASE_URL}/admin/auth-providers` (e.g. `''` or `'/github'`).
 * @param init Fetch options (method/body); auth + content-type headers are added here.
 * @param adminSessionToken The verified signed admin-session token to present upstream.
 * @param fetchImpl Fetch implementation (injectable for tests; defaults to global `fetch`).
 * @returns The upstream status and parsed body, or a `502` transport-failure result.
 */
async function forwardToRest(
  path: string,
  init: { method: string; body?: string },
  adminSessionToken: string,
  fetchImpl: typeof fetch
): Promise<AdminProviderProxyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${REST_API_BASE_URL}/admin/auth-providers${path}`, {
      method: init.method,
      body: init.body,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Session': adminSessionToken,
      },
      signal: controller.signal,
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // Upstream replied with a non-JSON body (crash page, empty reply): surface a structured
      // error rather than relaying unparseable output.
      return {
        status: 502,
        body: {
          error: 'invalid_upstream_response',
          message: `The configuration service returned an unreadable response (HTTP ${response.status}).`,
        },
      };
    }
    return { status: response.status, body };
  } catch {
    // Network error / timeout / abort — never log the request body (a PUT may carry a secret).
    return unreachableResult();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List every provider's masked config (forwards `GET /v1/admin/auth-providers`).
 *
 * @param adminSessionToken The verified signed admin-session token.
 * @param fetchImpl Fetch implementation (injectable for tests).
 * @returns The upstream status and body (an `AdminProviderListResponse` on 200).
 */
export async function proxyListAuthProviders(
  adminSessionToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminProviderProxyResult> {
  return forwardToRest('', { method: 'GET' }, adminSessionToken, fetchImpl);
}

/**
 * Apply a partial update to one provider (forwards `PUT /v1/admin/auth-providers/{id}`).
 *
 * On success (2xx) the in-process resolved-config cache (OLO-8.5) is invalidated so the change
 * reaches the next login immediately (OLO-8.6) instead of after the cache TTL.
 *
 * @param adminSessionToken The verified signed admin-session token.
 * @param providerId Provider slug from the route path (validated upstream; unknown ⇒ 404).
 * @param payload The partial update body, relayed verbatim.
 * @param fetchImpl Fetch implementation (injectable for tests).
 * @returns The upstream status and body (the provider's masked view on 200).
 */
export async function proxyUpdateAuthProvider(
  adminSessionToken: string,
  providerId: string,
  payload: AdminProviderUpdatePayload,
  fetchImpl: typeof fetch = fetch
): Promise<AdminProviderProxyResult> {
  const result = await forwardToRest(
    `/${encodeURIComponent(providerId)}`,
    { method: 'PUT', body: JSON.stringify(payload) },
    adminSessionToken,
    fetchImpl
  );
  if (result.status >= 200 && result.status < 300) {
    invalidateProviderConfigCache();
  }
  return result;
}

/**
 * Remove one provider's stored config entirely (forwards `DELETE /v1/admin/auth-providers/{id}`).
 *
 * The upstream drops the whole row — the provider reverts to env-only governance and its sealed
 * secret is destroyed — and replies with the provider's post-delete (all env-fallback) view, which
 * is relayed verbatim like every other response here.
 *
 * On success (2xx) the in-process resolved-config cache (OLO-8.5) is invalidated, so the next
 * login stops using the deleted DB config immediately rather than after the cache TTL.
 *
 * @param adminSessionToken The verified signed admin-session token.
 * @param providerId Provider slug from the route path (validated upstream; unknown ⇒ 404).
 * @param fetchImpl Fetch implementation (injectable for tests).
 * @returns The upstream status and body (the provider's post-delete masked view on 200).
 */
export async function proxyDeleteAuthProvider(
  adminSessionToken: string,
  providerId: string,
  fetchImpl: typeof fetch = fetch
): Promise<AdminProviderProxyResult> {
  const result = await forwardToRest(
    `/${encodeURIComponent(providerId)}`,
    { method: 'DELETE' },
    adminSessionToken,
    fetchImpl
  );
  if (result.status >= 200 && result.status < 300) {
    invalidateProviderConfigCache();
  }
  return result;
}
