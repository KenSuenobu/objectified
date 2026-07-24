/**
 * Keycloak issuer helper tests (OLO-9.5, #4988) for `lib/auth/keycloak-issuer.ts`.
 *
 * Pins the engine-neutral Keycloak facts: provider slug, issuer base URL (trailing slash trimmed,
 * blank counts as unset), and membership on the auto-link trust list.
 */
import { describe, test, expect } from '@jest/globals';

import { KEYCLOAK_PROVIDER_ID, keycloakIssuerBaseUrl } from '../lib/auth/keycloak-issuer';
import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('keycloak issuer env contract', () => {
  test('provider id is the stable slug keycloak', () => {
    expect(KEYCLOAK_PROVIDER_ID).toBe('keycloak');
  });

  test('unset / blank issuer yields empty string', () => {
    expect(keycloakIssuerBaseUrl({})).toBe('');
    expect(keycloakIssuerBaseUrl({ KEYCLOAK_ISSUER: '   ' })).toBe('');
  });

  test('KEYCLOAK_ISSUER is trimmed and trailing slash stripped', () => {
    expect(
      keycloakIssuerBaseUrl({ KEYCLOAK_ISSUER: 'https://kc.example.com/realms/apiome/' })
    ).toBe('https://kc.example.com/realms/apiome');
    expect(keycloakIssuerBaseUrl({ KEYCLOAK_ISSUER: '  http://localhost:8080/realms/apiome  ' })).toBe(
      'http://localhost:8080/realms/apiome'
    );
  });

  test('keycloak is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('keycloak')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('keycloak')).toBe(true);
  });
});
