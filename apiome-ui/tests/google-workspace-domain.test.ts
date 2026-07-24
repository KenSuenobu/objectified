/**
 * Google Workspace domain-gate tests (OLO-9.2, #4985) for `lib/auth/google-workspace-domain.ts`.
 *
 * This module is the engine-neutral core of Google sign-in — the provider slug, the issuer/discovery
 * base URL, the Workspace-domain read, and the `hd` claim gate — shared by the Better Auth generic-OIDC
 * provider (`better-auth-oauth-providers.ts`). Its guarantees are directly assertable:
 *
 *   1. Env contract — GOOGLE_ISSUER points discovery at a mock (OLO-7.4) and defaults to the real
 *      Google issuer; GOOGLE_WORKSPACE_DOMAIN is trimmed and blank counts as unset.
 *   2. Identity contract — the provider id is `google` (the value the resolution engine's trust list
 *      and the external_auth_providers rows key on) and `google` is on the auto-link trust list.
 *   3. Domain gate — with a domain configured, the `hd` claim is verified (case-insensitive), rejecting
 *      foreign/personal accounts; without it, any Google account is allowed.
 *
 * The provider construction and the end-to-end sign-in through the resolution engine are covered on the
 * live Better Auth path by `better-auth-oauth-providers.test.ts` and `verified-email-parity.test.ts`.
 */
import { describe, test, expect } from '@jest/globals';

import {
  GOOGLE_PROVIDER_ID,
  assertGoogleHostedDomain,
  googleIssuerBaseUrl,
  googleWorkspaceDomain,
  hostedDomainMatches,
} from '../lib/auth/google-workspace-domain';
import { AUTO_LINK_TRUSTED_PROVIDERS } from '../lib/auth/account-resolution';

// ---------------------------------------------------------------------------
// 1. Env contract
// ---------------------------------------------------------------------------

describe('env contract', () => {
  test('discovery defaults to the real Google issuer', () => {
    expect(googleIssuerBaseUrl({})).toBe('https://accounts.google.com');
  });

  test('GOOGLE_ISSUER points discovery at a mock issuer (OLO-7.4), trailing slash trimmed', () => {
    expect(googleIssuerBaseUrl({ GOOGLE_ISSUER: 'http://localhost:8091/google/' })).toBe(
      'http://localhost:8091/google'
    );
  });

  test('googleWorkspaceDomain reads GOOGLE_WORKSPACE_DOMAIN, blank counts as unset', () => {
    expect(googleWorkspaceDomain({})).toBeNull();
    expect(googleWorkspaceDomain({ GOOGLE_WORKSPACE_DOMAIN: '   ' })).toBeNull();
    expect(googleWorkspaceDomain({ GOOGLE_WORKSPACE_DOMAIN: '  corp.example.com  ' })).toBe(
      'corp.example.com'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Identity contract
// ---------------------------------------------------------------------------

describe('identity contract', () => {
  test('the provider id is `google` — the value every OLO seam keys on', () => {
    expect(GOOGLE_PROVIDER_ID).toBe('google');
  });

  test('`google` is on the auto-link trust list', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has(GOOGLE_PROVIDER_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Workspace-domain gate
// ---------------------------------------------------------------------------

describe('hostedDomainMatches', () => {
  test('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(hostedDomainMatches('corp.example.com', 'corp.example.com')).toBe(true);
    expect(hostedDomainMatches('  Corp.Example.COM ', 'corp.example.com')).toBe(true);
  });

  test('rejects a different domain, a missing claim, or a non-string claim', () => {
    expect(hostedDomainMatches('other.example.com', 'corp.example.com')).toBe(false);
    expect(hostedDomainMatches(undefined, 'corp.example.com')).toBe(false);
    expect(hostedDomainMatches(42, 'corp.example.com')).toBe(false);
  });
});

describe('assertGoogleHostedDomain', () => {
  test('is a no-op when no domain is configured (any account allowed)', () => {
    expect(() => assertGoogleHostedDomain({ hd: 'anything.com' }, null)).not.toThrow();
    expect(() => assertGoogleHostedDomain({}, null)).not.toThrow();
  });

  test('passes an account whose hd claim matches the configured domain', () => {
    expect(() =>
      assertGoogleHostedDomain({ hd: 'corp.example.com' }, 'corp.example.com')
    ).not.toThrow();
  });

  test('rejects a foreign-domain account', () => {
    expect(() =>
      assertGoogleHostedDomain({ hd: 'evil.example.com' }, 'corp.example.com')
    ).toThrow(/not a member of the 'corp.example.com'/);
  });

  test('rejects a personal account with no hd claim', () => {
    expect(() => assertGoogleHostedDomain({ email: 'me@gmail.com' }, 'corp.example.com')).toThrow(
      /not a member/
    );
  });
});
