import { NextRequest, NextResponse } from 'next/server';
import { isProviderEnabled } from '../../../../../lib/auth/provider-registry';
import { resolveProviderEnv } from '../../../../../lib/auth/provider-config-resolver';
import { resolveClientIp } from '../../../../../lib/auth/client-ip';
import {
  AUTH_RATE_LIMITED_CODE,
  checkRequestBudget,
} from '../../../../../lib/auth/login-rate-limit';

/**
 * Sets a short-lived cookie so the next OAuth callback is treated as self-signup (new account).
 * The provider must be enabled in this deployment's provider registry (OLO-2.3) — the same
 * gate that decides which sign-up buttons the login page renders.
 * Uses POST to prevent CSRF-style flow manipulation via cross-site GET requests.
 *
 * Signup completion is part of the auth surface, so the route carries a per-IP
 * request budget (OLO-7.1): over-budget calls get a structured 429
 * (`auth-rate-limited`) with `Retry-After` before any other work runs.
 */
export async function POST(request: NextRequest) {
  const ipBudget = checkRequestBudget(`signup-intent:ip:${resolveClientIp(request.headers)}`);
  if (!ipBudget.allowed) {
    return NextResponse.json(
      {
        error: 'Too many signup requests. Try again later.',
        code: AUTH_RATE_LIMITED_CODE,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(ipBudget.retryAfterMs / 1000))) },
      }
    );
  }

  // Validate Origin to prevent cross-site requests
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    const originHost = new URL(origin).host;
    if (originHost !== host) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }
  const provider = body?.provider;
  if (typeof provider !== 'string' || !isProviderEnabled(provider, await resolveProviderEnv())) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }

  const response = NextResponse.json({ success: true, provider });
  response.cookies.set(
    'oauth_signup_intent',
    JSON.stringify({
      provider,
      timestamp: Date.now(),
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
      sameSite: 'lax',
    }
  );
  return response;
}
