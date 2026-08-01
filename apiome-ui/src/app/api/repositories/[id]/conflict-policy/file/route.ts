/**
 * Per-file conflict-policy override (RAR-4.5, #3531) — proxies to
 * `PUT /v1/tenants/{slug}/repositories/{id}/conflict-policy/file`.
 *
 * A `policy` value writes the override so one file deviates from the repository-wide
 * setting; `policy: null` clears it and the file inherits the repository policy again.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  forwardConflictPolicyRequest,
  readConflictPolicyBody,
} from '@lib/repository-conflict-policy-proxy';

export const dynamic = 'force-dynamic';

/**
 * Set or clear one file's conflict-policy override.
 *
 * @param request Carries `{ branch, path, policy }` (`policy: null` clears).
 * @param params Route params carrying the repository id.
 * @returns The repository's conflict-policy projection after the change.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = await readConflictPolicyBody(request);
  if ('error' in parsed) return parsed.error;
  return forwardConflictPolicyRequest(id, 'PUT', '/file', parsed.body);
}
