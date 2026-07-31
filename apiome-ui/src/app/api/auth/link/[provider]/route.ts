import { NextRequest, NextResponse } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import {
  AUTH_ERROR_CODES,
  LINKABLE_PROVIDERS,
} from '../../../../../../lib/auth/account-resolution';
import { isProviderEnabled } from '../../../../../../lib/auth/provider-registry';
import { resolveProviderEnv } from '../../../../../../lib/auth/provider-config-resolver';
import { resolveClientIp } from '../../../../../../lib/auth/client-ip';
import {
  AUTH_RATE_LIMITED_CODE,
  checkRequestBudget,
} from '../../../../../../lib/auth/login-rate-limit';

/** Structured 429 for an exhausted link-route budget (OLO-7.1, #4223). */
function rateLimitedResponse(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    {
      error: 'Too many linking requests. Try again later.',
      code: AUTH_RATE_LIMITED_CODE,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    }
  );
}

/**
 * Whether this deployment can start a link flow for `provider` (OLO-2.2, #4194).
 *
 * The slug must belong to the linkable-provider vocabulary (`github` | `gitlab` | `azure` —
 * the same set V181 pins at the DB level) AND be enabled in the provider registry
 * (OLO-2.3): the NextAuth route only registers env-configured providers, so setting a
 * linking-intent cookie for a disabled one would only dead-end at the identity provider.
 *
 * @param provider The provider slug from the route path.
 * @returns True when a linking-intent cookie for this provider can lead to a working OAuth flow.
 */
async function isProviderLinkable(provider: string): Promise<boolean> {
  return LINKABLE_PROVIDERS.has(provider) && isProviderEnabled(provider, await resolveProviderEnv());
}

/**
 * API endpoint to set linking intent cookie before OAuth flow
 * This endpoint checks if user is logged in and sets a cookie to indicate linking intent
 *
 * Unknown or unconfigured providers are refused with 400 and the stable
 * `provider-not-configured` code (the structured auth error contract, OLO-1.5).
 *
 * The route carries per-IP and per-account request budgets (OLO-7.1): the IP
 * budget runs before the session lookup so floods stay cheap; the account
 * budget runs once the caller is known. Over-budget calls get a structured 429
 * (`auth-rate-limited`) with `Retry-After`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const ipBudget = checkRequestBudget(`link:ip:${resolveClientIp(request.headers)}`);
  if (!ipBudget.allowed) {
    return rateLimitedResponse(ipBudget.retryAfterMs);
  }

  const session = await getAuthSession();

  if (!session || !(session.user as any)?.user_id) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401 }
    );
  }

  const userId = (session.user as any).user_id;

  // Per-account budget: one user cannot spray link-intent cookies from many IPs.
  const accountBudget = checkRequestBudget(`link:acct:${userId}`);
  if (!accountBudget.allowed) {
    return rateLimitedResponse(accountBudget.retryAfterMs);
  }

  const { provider } = await params;

  if (!(await isProviderLinkable(provider))) {
    return NextResponse.json(
      {
        error: `Provider '${provider}' is not available for linking on this deployment`,
        code: AUTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      },
      { status: 400 }
    );
  }

  // Create response with success status
  const response = NextResponse.json({
    success: true,
    provider,
    userId
  });

  // Set the linking intent cookie
  response.cookies.set('oauth_link_intent', JSON.stringify({
    userId,
    provider,
    timestamp: Date.now()
  }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600, // 10 minutes
    path: '/',
    sameSite: 'lax' as const
  });

  return response;
}
