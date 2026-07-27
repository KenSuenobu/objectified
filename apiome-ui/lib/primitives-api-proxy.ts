/**
 * Shared helpers for /api/primitives/* and /api/types/* proxy routes.
 */

import { getAuthSession } from '@lib/auth/server-session';
import { getTenantById } from '@lib/db/helper';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';
import { restErrorMessage } from './rest-error-message';

// Re-exported so proxy callers keep one import site for the error-rendering contract.
export { restErrorMessage };

export interface SessionUser {
  user_id?: string;
  email?: string | null;
  name?: string | null;
  current_tenant_id?: string;
}

export async function getAuthenticatedTenantContext(): Promise<
  | { ok: true; user: SessionUser; tenantSlug: string }
  | { ok: false; status: number; error: string }
> {
  const session = await getAuthSession();
  const user = session?.user as SessionUser | undefined;

  if (!user?.user_id) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  if (!user.current_tenant_id) {
    return { ok: false, status: 400, error: 'No tenant selected' };
  }

  const tenant = await getTenantById(user.current_tenant_id);
  if (!tenant?.slug) {
    return { ok: false, status: 404, error: 'Tenant not found' };
  }

  return { ok: true, user, tenantSlug: tenant.slug };
}

export async function proxyRestGet(
  user: SessionUser,
  path: string
): Promise<{ data: unknown; error: string | null; status: number }> {
  const response = await fetch(`${REST_API_BASE_URL}${path}`, {
    method: 'GET',
    headers: createRestAuthHeaders(user),
    cache: 'no-store',
  });

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const text = await response.text();
    return { data: null, error: text || 'Request failed', status: response.status || 500 };
  }

  const data = await response.json();
  if (!response.ok) {
    return { data: null, error: restErrorMessage(data), status: response.status };
  }

  return { data, error: null, status: response.status };
}


/**
 * Issue a body-carrying request (POST/PUT) to the REST API and normalize the result.
 *
 * Shared by {@link proxyRestPost} and {@link proxyRestPut} so the two write verbs handle
 * non-JSON responses and FastAPI ``detail`` error payloads identically.
 */
async function proxyRestWrite(
  method: 'POST' | 'PUT' | 'PATCH',
  user: SessionUser,
  path: string,
  body?: unknown
): Promise<{ data: unknown; error: string | null; status: number }> {
  const response = await fetch(`${REST_API_BASE_URL}${path}`, {
    method,
    headers: createRestAuthHeaders(user),
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const text = await response.text();
    return { data: null, error: text || 'Request failed', status: response.status || 500 };
  }

  const data = await response.json();
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : 'Request failed';
    return { data: null, error: detail, status: response.status };
  }

  return { data, error: null, status: response.status };
}

export async function proxyRestPost(
  user: SessionUser,
  path: string,
  body?: unknown
): Promise<{ data: unknown; error: string | null; status: number }> {
  return proxyRestWrite('POST', user, path, body);
}

export async function proxyRestPut(
  user: SessionUser,
  path: string,
  body?: unknown
): Promise<{ data: unknown; error: string | null; status: number }> {
  return proxyRestWrite('PUT', user, path, body);
}

export async function proxyRestPatch(
  user: SessionUser,
  path: string,
  body?: unknown
): Promise<{ data: unknown; error: string | null; status: number }> {
  return proxyRestWrite('PATCH', user, path, body);
}

export async function proxyRestDelete(
  user: SessionUser,
  path: string
): Promise<{ data: unknown; error: string | null; status: number }> {
  const response = await fetch(`${REST_API_BASE_URL}${path}`, {
    method: 'DELETE',
    headers: createRestAuthHeaders(user),
    cache: 'no-store',
  });

  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    const text = await response.text();
    if (!response.ok) {
      return { data: null, error: text || 'Request failed', status: response.status || 500 };
    }
    return { data: null, error: null, status: response.status };
  }

  const data = await response.json();
  if (!response.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : 'Request failed';
    return { data: null, error: detail, status: response.status };
  }

  return { data, error: null, status: response.status };
}
