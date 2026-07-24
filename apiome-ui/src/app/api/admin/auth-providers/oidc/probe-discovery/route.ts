/**
 * Admin OIDC discovery probe (OLO-9.6, #4989).
 *
 * `POST /api/admin/auth-providers/oidc/probe-discovery` verifies that the configured issuer
 * serves a usable OpenID Provider Metadata document. Called from the settings screen's Validate
 * button so a bad issuer surfaces a clear error instead of a broken login page. Auth matches the
 * other auth-provider proxies (signed `admin_session` cookie).
 *
 * Body: `{ "issuer"?: string }` — when omitted or blank, falls back to `process.env.OIDC_ISSUER`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyAdminSessionToken } from '@lib/auth/admin-session';
import { oidcIssuerBaseUrl, probeOidcDiscovery } from '@lib/auth/oidc-issuer';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_session')?.value;

  if (!token) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Super-admin authentication required.' },
      { status: 401 }
    );
  }
  if (!verifyAdminSessionToken(token)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Invalid or expired super-admin session.' },
      { status: 403 }
    );
  }

  let bodyIssuer: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const raw = (body as { issuer?: unknown }).issuer;
      if (typeof raw === 'string' && raw.trim().length > 0) {
        bodyIssuer = raw.trim();
      }
    }
  } catch {
    // Empty / non-JSON body is fine — fall back to env.
  }

  const issuer = bodyIssuer ?? oidcIssuerBaseUrl(process.env);
  if (!issuer) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Sign-in provider 'OIDC' (oidc) discovery failed: issuer is unset or blank. " +
          'Set OIDC_ISSUER on this card or in the environment.',
      },
      { status: 200 }
    );
  }

  const result = await probeOidcDiscovery(issuer);
  return NextResponse.json(result, { status: 200 });
}
