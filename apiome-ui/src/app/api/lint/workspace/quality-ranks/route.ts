/**
 * GET /api/lint/workspace/quality-ranks — per-format grade drift series (IXH-2.7, #5102).
 *
 * Forwards the window (`days`), the optional `scope` / `stage` narrowing, and the project scope
 * to the REST workspace router; every other query parameter is dropped, matching the whitelist
 * discipline the sibling workspace proxies use.
 */
import { NextRequest } from 'next/server';
import { proxyToRest, requireSessionUser } from '../proxy';

/** Query parameters this proxy forwards verbatim. */
const QUALITY_RANK_PARAMS = ['days', 'scope', 'stage', 'projectId'] as const;

export async function GET(request: NextRequest) {
  const auth = await requireSessionUser();
  if ('error' in auth) return auth.error;
  const params = new URLSearchParams();
  for (const key of QUALITY_RANK_PARAMS) {
    const value = request.nextUrl.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  return proxyToRest(auth, `/lint/workspace/quality-ranks${query}`);
}
