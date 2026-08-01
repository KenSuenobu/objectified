/**
 * Tenant-wide refresh-activity signals for the dashboard "Refresh activity"
 * widget (RAR-5.5, #3536).
 *
 * Returns one row per stored import-spec lineage across every repository in
 * the current tenant, carrying the raw signals the client needs to derive each
 * lineage's refresh state (`summarizeRefreshActivity` +
 * `computeRefreshStatus`). Read-only and tenant-scoped, mirroring the per-repo
 * refresh-specs route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import { listTenantRefreshActivitySignals } from '@lib/db/repository-import-metrics';

export const dynamic = 'force-dynamic';

interface SessionUser {
  user_id?: string;
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

  let limit: number | undefined;
  const rawLimit = request.nextUrl.searchParams.get('limit');
  if (rawLimit != null && rawLimit !== '') {
    const n = parseInt(rawLimit, 10);
    if (!Number.isNaN(n)) limit = n;
  }

  try {
    const signals = await listTenantRefreshActivitySignals({
      tenantId: user.current_tenant_id,
      limit,
    });
    return NextResponse.json({ success: true, signals });
  } catch (e) {
    console.error('[repositories/refresh-activity]', e);
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Failed to load refresh activity' },
      { status: 500 }
    );
  }
}
