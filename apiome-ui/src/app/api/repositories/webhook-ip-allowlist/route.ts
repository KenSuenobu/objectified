/**
 * Webhook source-IP allowlist (REPO-7.6, #2804).
 *
 * Proxies to `/v1/tenants/{slug}/repository-webhook-ip-allowlist`:
 *
 *   GET   the allowlist — deployment posture, cached provider ranges, this tenant's entries
 *   POST  add one additional range
 *   PUT   set this tenant's enforcement policy (the bypass)
 *
 * Auth and forwarding only; the shared halves live in `@lib/webhook-ip-allowlist-proxy`.
 *
 * `webhook-ip-allowlist` is a static sibling of `[id]` under `/api/repositories`, and Next.js
 * matches static segments ahead of dynamic ones, so it never collides with
 * `/api/repositories/{uuid}`.
 */

import { NextRequest } from 'next/server';
import {
  allowlistUrl,
  forwardAllowlistRequest,
  resolveAllowlistTenant,
} from '@lib/webhook-ip-allowlist-proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  const resolved = await resolveAllowlistTenant();
  if ('error' in resolved) return resolved.error;
  return forwardAllowlistRequest(allowlistUrl(resolved.slug), {
    method: 'GET',
    user: resolved.user,
  });
}

export async function POST(request: NextRequest) {
  const resolved = await resolveAllowlistTenant();
  if ('error' in resolved) return resolved.error;
  const body = await request.json().catch(() => ({}));
  return forwardAllowlistRequest(allowlistUrl(resolved.slug, '/entries'), {
    method: 'POST',
    user: resolved.user,
    body,
  });
}

export async function PUT(request: NextRequest) {
  const resolved = await resolveAllowlistTenant();
  if ('error' in resolved) return resolved.error;
  const body = await request.json().catch(() => ({}));
  return forwardAllowlistRequest(allowlistUrl(resolved.slug, '/policy'), {
    method: 'PUT',
    user: resolved.user,
    body,
  });
}
