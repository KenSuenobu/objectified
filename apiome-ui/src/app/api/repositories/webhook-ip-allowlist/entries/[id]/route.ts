/**
 * One webhook source-IP allowlist entry (REPO-7.6, #2804).
 *
 * PATCH enables or disables the entry; DELETE removes it. Disabling exists so narrowing the
 * filter during an incident does not cost the entry and the reason it was added — an operator
 * who deletes and later re-types a range loses the "why", which is the part nobody can
 * reconstruct.
 *
 * Proxies to `/v1/tenants/{slug}/repository-webhook-ip-allowlist/entries/{id}`; the
 * tenant-administrator check and the tenant scoping of the id both live in REST.
 */

import { NextRequest } from 'next/server';
import {
  allowlistUrl,
  forwardAllowlistRequest,
  resolveAllowlistTenant,
} from '@lib/webhook-ip-allowlist-proxy';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolved = await resolveAllowlistTenant();
  if ('error' in resolved) return resolved.error;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  return forwardAllowlistRequest(
    allowlistUrl(resolved.slug, `/entries/${encodeURIComponent(id)}`),
    { method: 'PATCH', user: resolved.user, body }
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolved = await resolveAllowlistTenant();
  if ('error' in resolved) return resolved.error;
  const { id } = await params;
  return forwardAllowlistRequest(
    allowlistUrl(resolved.slug, `/entries/${encodeURIComponent(id)}`),
    { method: 'DELETE', user: resolved.user }
  );
}
