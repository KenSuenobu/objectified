/**
 * Repository refresh conflict policy (RAR-4.5, #3531) — proxies to
 * `GET/PUT /v1/tenants/{slug}/repositories/{id}/conflict-policy`.
 *
 * The policy decides what auto-refresh does when it meets a version that was hand-edited
 * after the original import: overwrite it, hold it for review (the default), or land the
 * refresh on a new branch.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  forwardConflictPolicyRequest,
  readConflictPolicyBody,
} from '@lib/repository-conflict-policy-proxy';

export const dynamic = 'force-dynamic';

/**
 * Read the repository's conflict policy and its per-file overrides.
 *
 * @param _request Unused; the read takes no body.
 * @param params Route params carrying the repository id.
 * @returns The flattened conflict-policy projection.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  return forwardConflictPolicyRequest(id, 'GET');
}

/**
 * Set the repository-wide conflict policy.
 *
 * @param request Carries `{ policy }`.
 * @param params Route params carrying the repository id.
 * @returns The projection after the update.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = await readConflictPolicyBody(request);
  if ('error' in parsed) return parsed.error;
  return forwardConflictPolicyRequest(id, 'PUT', '', parsed.body);
}
