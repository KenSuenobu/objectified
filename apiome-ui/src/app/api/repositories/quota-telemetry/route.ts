/**
 * Repository quota & rate-limit telemetry (REPO-7.3, #2801).
 *
 * Proxies to `GET /v1/tenants/{slug}/repository-quota-telemetry`, which returns the tenant's
 * current polling-quota position alongside its rolling-window counters. This handler adds no
 * logic of its own beyond auth and the one forwarded parameter — the range is validated by
 * REST, which is also the thing that knows its own ceiling.
 *
 * `quota-telemetry` is a static sibling of `[id]` under `/api/repositories`, and Next.js
 * matches static segments ahead of dynamic ones, so it never collides with
 * `/api/repositories/{uuid}`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import { getTenantById } from '@lib/db/helper';
import { createRestAuthHeaders, REST_API_BASE_URL } from '@lib/rest-auth';

export const dynamic = 'force-dynamic';

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

  const days = request.nextUrl.searchParams.get('days');
  const qs = days ? `?days=${encodeURIComponent(days)}` : '';
  const url = `${REST_API_BASE_URL}/tenants/${encodeURIComponent(tenantSlug)}/repository-quota-telemetry${qs}`;

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
    if (rest.ok && parsed && typeof parsed === 'object' && 'telemetry' in parsed) {
      return NextResponse.json(parsed);
    }
    const err =
      parsed && typeof parsed === 'object' && 'detail' in parsed
        ? String((parsed as { detail: unknown }).detail)
        : `Quota telemetry API error (${rest.status})`;
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
