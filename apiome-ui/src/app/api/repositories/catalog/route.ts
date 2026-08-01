/**
 * Cross-repository discovered-spec catalog (REPO-6.4).
 *
 * Proxies to GET /v1/tenants/{slug}/repository-files, which searches, filters, orders and
 * paginates in SQL. This handler adds no logic of its own beyond auth and an allowlist —
 * everything the catalog page can ask for is a query parameter that REST validates.
 *
 * Note the route path: `catalog` is a static sibling of `[id]` under `/api/repositories`, and
 * Next.js matches static segments ahead of dynamic ones, so this never collides with
 * `/api/repositories/{uuid}`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import { getTenantById } from '@lib/db/helper';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';

export const dynamic = 'force-dynamic';

/**
 * Query parameters forwarded to REST. Anything else the browser appends is dropped rather
 * than passed through, so a crafted URL cannot reach an endpoint parameter the catalog page
 * does not intend to expose.
 */
const FORWARD_PARAMS = [
  'q',
  'format',
  'repository_id',
  'project_id',
  'status',
  'importable_only',
  'all_branches',
  'sort',
  'limit',
  'offset',
  'include_facets',
] as const;

interface SessionUser {
  user_id?: string;
  email?: string | null;
  name?: string | null;
  current_tenant_id?: string;
}

export async function GET(request: NextRequest) {
  const session = await getAuthSession();
  const user = session?.user as SessionUser | undefined;
  if (!user?.user_id) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  if (!user.current_tenant_id) {
    return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
  }

  const tenant = await getTenantById(user.current_tenant_id);
  const tenantSlug =
    tenant && typeof tenant === 'object' && 'slug' in tenant
      ? String((tenant as { slug: string }).slug)
      : '';
  if (!tenantSlug) {
    return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 400 });
  }

  const incoming = request.nextUrl.searchParams;
  const qs = new URLSearchParams();
  for (const key of FORWARD_PARAMS) {
    const v = incoming.get(key);
    if (v != null && v !== '') {
      qs.set(key, v);
    }
  }
  const q = qs.toString();
  const url = `${REST_API_BASE_URL}/tenants/${encodeURIComponent(tenantSlug)}/repository-files${q ? `?${q}` : ''}`;

  try {
    const rest = await fetch(url, {
      method: 'GET',
      headers: createRestAuthHeaders(user),
      cache: 'no-store',
    });
    const text = await rest.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    if (rest.ok && parsed && typeof parsed === 'object' && 'specs' in parsed) {
      return NextResponse.json(parsed);
    }
    const err =
      parsed && typeof parsed === 'object' && 'detail' in parsed
        ? String((parsed as { detail: unknown }).detail)
        : `Spec catalog API error (${rest.status})`;
    return NextResponse.json(
      { success: false, error: err },
      { status: rest.status >= 400 ? rest.status : 502 }
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Repository API unavailable (apiome-rest not reachable).' },
      { status: 503 }
    );
  }
}
