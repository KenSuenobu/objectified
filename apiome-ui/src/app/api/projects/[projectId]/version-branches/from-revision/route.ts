/**
 * POST /api/projects/[projectId]/version-branches/from-revision
 * Proxies to REST POST /v1/versions/{tenantSlug}/{projectId}/version-branches/from-revision (#2570, #2571).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import jwt from 'jsonwebtoken';
import { getTenantById } from '@lib/db/helper';
import { getJwtSigningSecret } from '@lib/rest-auth';

const REST_API_BASE_URL = process.env.NEXT_PUBLIC_REST_API_BASE_URL || 'http://localhost:8000/v1';

interface SessionUser {
  user_id?: string;
  email?: string | null;
  name?: string | null;
  current_tenant_id?: string;
}

function createAuthHeaders(user: SessionUser): Record<string, string> {
  if (!user.user_id) {
    return { 'Content-Type': 'application/json' };
  }
  const secret = getJwtSigningSecret();
  if (!secret) {
    return { 'Content-Type': 'application/json' };
  }
  const encodedToken = jwt.sign(
    {
      user_id: user.user_id,
      sub: user.user_id,
      email: user.email,
      name: user.name,
      current_tenant_id: user.current_tenant_id,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' }
  );
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${encodedToken}`,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const session = await getAuthSession();
    if (!session?.user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const user = session.user as SessionUser;
    const tenantId = user.current_tenant_id;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'No tenant selected' }, { status: 400 });
    }
    const tenant = await getTenantById(tenantId);
    if (!tenant?.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }
    const { projectId } = await params;
    const body = await request.json();
    const branchName = typeof body.branchName === 'string' ? body.branchName : '';
    const sourceRevisionId = typeof body.sourceRevisionId === 'string' ? body.sourceRevisionId : '';
    if (!branchName.trim() || !sourceRevisionId.trim()) {
      return NextResponse.json(
        { success: false, error: 'branchName and sourceRevisionId are required' },
        { status: 400 }
      );
    }

    const url = `${REST_API_BASE_URL}/versions/${encodeURIComponent(tenant.slug)}/${encodeURIComponent(projectId)}/version-branches/from-revision`;
    const response = await fetch(url, {
      method: 'POST',
      headers: createAuthHeaders(user),
      body: JSON.stringify({
        branchName: branchName.trim(),
        sourceRevisionId: sourceRevisionId.trim(),
      }),
    });

    const text = await response.text();
    let data: Record<string, unknown> | null = null;
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      return NextResponse.json(
        { success: false, error: text || 'Invalid JSON from REST API' },
        { status: response.status || 500 }
      );
    }

    if (!response.ok) {
      const detail = data?.detail;
      let message = 'Branch creation failed';
      if (typeof detail === 'string') {
        message = detail;
      } else if (detail && typeof detail === 'object' && detail !== null && 'message' in detail) {
        message = String((detail as { message: string }).message);
      }
      return NextResponse.json(
        {
          success: false,
          error: message,
          ...(typeof data === 'object' && data !== null ? data : {}),
        },
        { status: response.status }
      );
    }

    const branchRaw = data?.branch as Record<string, unknown> | undefined;
    const tipRaw = data?.tipVersion as Record<string, unknown> | undefined;
    const tipRevisionId =
      typeof branchRaw?.tipRevisionId === 'string'
        ? branchRaw.tipRevisionId
        : typeof branchRaw?.tip_revision_id === 'string'
          ? branchRaw.tip_revision_id
          : typeof branchRaw?.tip_version_id === 'string'
            ? branchRaw.tip_version_id
            : typeof tipRaw?.id === 'string'
              ? tipRaw.id
              : '';
    const tipVersionString =
      typeof tipRaw?.versionId === 'string'
        ? tipRaw.versionId
        : typeof tipRaw?.version_id === 'string'
          ? tipRaw.version_id
          : undefined;

    return NextResponse.json({
      success: true,
      branch: branchRaw
        ? {
            id: String(branchRaw.id ?? ''),
            name: String(branchRaw.name ?? ''),
            tip_version_id: tipRevisionId,
            tip_version_string: tipVersionString,
            branched_from_revision_id:
              typeof branchRaw.branchedFromRevisionId === 'string'
                ? branchRaw.branchedFromRevisionId
                : typeof branchRaw.branched_from_revision_id === 'string'
                  ? branchRaw.branched_from_revision_id
                  : undefined,
          }
        : undefined,
      tipVersion: data?.tipVersion,
      idempotentReplay: Boolean(data?.idempotentReplay ?? data?.idempotent_replay),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Internal server error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
