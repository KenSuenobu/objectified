/**
 * API Proxy for a Catalog Item's Source Material (MFI-23.9)
 *
 * Proxies `GET /api/catalog/[itemId]/source` to the REST service's
 * `GET /v1/catalog/{tenantSlug}/{itemId}/source`, minting a short-lived JWT from the NextAuth
 * session exactly like the sibling catalog detail proxy (`../route.ts`).
 *
 * The upstream serves the original source material three ways, each passed through unchanged:
 *   - captured inline content  -> a `Content-Disposition: attachment` download, streamed back;
 *   - a recorded source URL    -> a redirect, surfaced to the browser so *it* fetches the URL
 *                                 (the redirect is deliberately not followed server-side, to avoid
 *                                 turning the proxy into an SSRF vector against the stored URL);
 *   - nothing captured         -> a JSON 404 ("no source material captured").
 *
 * Read-only — catalog items are minted by the import routing, not through this API.
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

/** Build a Bearer JWT from the session for the REST call (HS256, 1h), matching the other proxies. */
function createAuthHeaders(user: SessionUser): Record<string, string> {
  const secret = getJwtSigningSecret();
  if (!user.user_id || !secret) {
    return { 'Content-Type': 'application/json' };
  }
  const token = jwt.sign(
    {
      user_id: user.user_id,
      sub: user.user_id,
      email: user.email,
      name: user.name,
      current_tenant_id: user.current_tenant_id,
    },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * GET /api/catalog/[itemId]/source
 * Stream (or redirect to) a catalog item's original source material.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> },
) {
  try {
    const { itemId } = await params;
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
    if (!tenant || !tenant.slug) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }

    const headers = createAuthHeaders({
      user_id: user.user_id,
      email: session.user.email,
      name: session.user.name,
      current_tenant_id: tenantId,
    });

    const response = await fetch(
      `${REST_API_BASE_URL}/catalog/${tenant.slug}/${itemId}/source`,
      { method: 'GET', headers, redirect: 'manual' },
    );

    // URL-sourced item: hand the redirect to the browser rather than following it here.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return NextResponse.redirect(location, 307);
      }
    }

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      // Errors (e.g. 404 no source captured) come back as JSON — surface them as JSON.
      if (contentType.includes('application/json')) {
        const data = await response.json();
        return NextResponse.json(
          { success: false, error: (data && (data.detail || data.error)) || 'Failed to fetch source' },
          { status: response.status },
        );
      }
      const text = await response.text();
      return NextResponse.json(
        { success: false, error: text || 'Failed to fetch source' },
        { status: response.status },
      );
    }

    // Stream the captured source straight through with its download headers.
    const body = await response.arrayBuffer();
    const disposition = response.headers.get('content-disposition');
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': contentType || 'application/octet-stream',
        ...(disposition ? { 'content-disposition': disposition } : {}),
      },
    });
  } catch (error) {
    console.error('Error fetching catalog item source:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
