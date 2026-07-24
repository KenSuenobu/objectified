/**
 * Auth0 issuer helper tests (OLO-9.7, #4990) for `lib/auth/auth0-issuer.ts`.
 *
 * Pins the engine-neutral Auth0 facts: provider slug, issuer base URL (trailing slash trimmed,
 * blank counts as unset), and membership on the auto-link trust list.
 */
import { describe, test, expect } from '@jest/globals';

import { AUTH0_PROVIDER_ID, auth0IssuerBaseUrl } from '../lib/auth/auth0-issuer';
import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('auth0 issuer env contract', () => {
  test('provider id is the stable slug auth0', () => {
    expect(AUTH0_PROVIDER_ID).toBe('auth0');
  });

  test('unset / blank issuer yields empty string', () => {
    expect(auth0IssuerBaseUrl({})).toBe('');
    expect(auth0IssuerBaseUrl({ AUTH0_ISSUER: '   ' })).toBe('');
  });

  test('AUTH0_ISSUER is trimmed and trailing slash stripped', () => {
    expect(auth0IssuerBaseUrl({ AUTH0_ISSUER: 'https://acme.auth0.com/' })).toBe(
      'https://acme.auth0.com'
    );
    expect(auth0IssuerBaseUrl({ AUTH0_ISSUER: '  http://localhost:9008/auth0  ' })).toBe(
      'http://localhost:9008/auth0'
    );
  });

  test('auth0 is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('auth0')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('auth0')).toBe(true);
  });
});
