/**
 * Contract tests for auth-surface rate limiting in the UI route handlers (OLO-7.1, #4223).
 *
 * Standing up the full auth + fetch stack for these handlers is heavy, so — like the
 * catalog-proxy contract tests — these assert the source-level contract the auth surface
 * depends on: the link-intent and signup-intent routes consume the shared request budget
 * (per-IP, and per-account where a session exists) and answer over-budget calls with a
 * structured 429 + `Retry-After`; and the super-admin form keys off the shared IP resolver.
 * The budget/lockout behavior itself is covered by real unit tests in
 * `tests/lib/login-rate-limit.test.ts`, `tests/lib/client-ip.test.ts`, and (for the Better Auth
 * credential sign-in hooks) `tests/better-auth-credentials.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const APP_API = path.resolve(__dirname, '..', '..', 'src', 'app', 'api');
const LINK_ROUTE = path.join(APP_API, 'auth', 'link', '[provider]', 'route.ts');
const SIGNUP_INTENT_ROUTE = path.join(APP_API, 'auth', 'signup-intent', 'route.ts');
const ADMIN_AUTH_ROUTE = path.join(APP_API, 'admin', 'auth', 'route.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('link route (GET /api/auth/link/[provider])', () => {
  const src = read(LINK_ROUTE);

  it('enforces a per-IP request budget before the session lookup', () => {
    expect(src).toMatch(/checkRequestBudget\(`link:ip:\$\{resolveClientIp\(request\.headers\)\}`\)/);
    expect(src.indexOf('link:ip:')).toBeLessThan(src.indexOf('getAuthSession()'));
  });

  it('enforces a per-account request budget once the caller is known', () => {
    expect(src).toMatch(/checkRequestBudget\(`link:acct:\$\{userId\}`\)/);
    expect(src.indexOf('getAuthSession()')).toBeLessThan(src.indexOf('link:acct:'));
  });

  it('answers over-budget calls with a structured 429 and Retry-After', () => {
    expect(src).toContain('AUTH_RATE_LIMITED_CODE');
    expect(src).toMatch(/status: 429/);
    expect(src).toMatch(/'Retry-After'/);
  });
});

describe('signup-intent route (POST /api/auth/signup-intent)', () => {
  const src = read(SIGNUP_INTENT_ROUTE);

  it('enforces a per-IP request budget before any other work', () => {
    expect(src).toMatch(/checkRequestBudget\(`signup-intent:ip:\$\{resolveClientIp\(request\.headers\)\}`\)/);
    // The budget must run ahead of the Origin/CSRF validation.
    expect(src.indexOf('signup-intent:ip:')).toBeLessThan(src.indexOf("headers.get('origin')"));
  });

  it('answers over-budget calls with a structured 429 and Retry-After', () => {
    expect(src).toContain('AUTH_RATE_LIMITED_CODE');
    expect(src).toMatch(/status: 429/);
    expect(src).toMatch(/'Retry-After'/);
  });
});

describe('super-admin password form (POST /api/admin/auth)', () => {
  const src = read(ADMIN_AUTH_ROUTE);

  it('keys its existing per-IP lockout off the shared client-IP resolver', () => {
    expect(src).toMatch(/resolveClientIp\(request\.headers\)/);
    expect(src).toContain('checkLoginRateLimit');
    expect(src).toMatch(/status: 429/);
  });
});
