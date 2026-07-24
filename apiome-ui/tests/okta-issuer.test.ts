/**
 * Okta issuer helper tests (OLO-9.3, #4986) for `lib/auth/okta-issuer.ts`.
 *
 * Pins the engine-neutral Okta facts: provider slug, issuer base URL (trailing slash trimmed,
 * blank counts as unset), and membership on the auto-link trust list.
 */
import { describe, test, expect } from '@jest/globals';

import { OKTA_PROVIDER_ID, oktaIssuerBaseUrl } from '../lib/auth/okta-issuer';
import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('okta issuer env contract', () => {
  test('provider id is the stable slug okta', () => {
    expect(OKTA_PROVIDER_ID).toBe('okta');
  });

  test('unset / blank issuer yields empty string', () => {
    expect(oktaIssuerBaseUrl({})).toBe('');
    expect(oktaIssuerBaseUrl({ OKTA_ISSUER: '   ' })).toBe('');
  });

  test('OKTA_ISSUER is trimmed and trailing slash stripped', () => {
    expect(oktaIssuerBaseUrl({ OKTA_ISSUER: 'https://acme.okta.com/oauth2/default/' })).toBe(
      'https://acme.okta.com/oauth2/default'
    );
    expect(oktaIssuerBaseUrl({ OKTA_ISSUER: '  http://localhost:9006/okta  ' })).toBe(
      'http://localhost:9006/okta'
    );
  });

  test('okta is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('okta')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('okta')).toBe(true);
  });
});
