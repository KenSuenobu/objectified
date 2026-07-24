/**
 * Generic OIDC issuer helper tests (OLO-9.6, #4989) for `lib/auth/oidc-issuer.ts`.
 *
 * Pins the engine-neutral OIDC facts: provider slug, issuer base URL (trailing slash trimmed,
 * blank counts as unset), optional display name / scopes, discovery probe behaviour, and membership
 * on the auto-link trust list.
 */
import { describe, test, expect } from '@jest/globals';

import {
  OIDC_PROVIDER_ID,
  OIDC_DEFAULT_SCOPES,
  oidcIssuerBaseUrl,
  oidcDisplayName,
  oidcScopes,
  probeOidcDiscovery,
  type OidcDiscoveryFetch,
} from '../lib/auth/oidc-issuer';
import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('oidc issuer env contract', () => {
  test('provider id is the stable slug oidc', () => {
    expect(OIDC_PROVIDER_ID).toBe('oidc');
  });

  test('unset / blank issuer yields empty string', () => {
    expect(oidcIssuerBaseUrl({})).toBe('');
    expect(oidcIssuerBaseUrl({ OIDC_ISSUER: '   ' })).toBe('');
  });

  test('OIDC_ISSUER is trimmed and trailing slash stripped', () => {
    expect(oidcIssuerBaseUrl({ OIDC_ISSUER: 'https://auth.example.com/' })).toBe(
      'https://auth.example.com'
    );
    expect(oidcIssuerBaseUrl({ OIDC_ISSUER: '  http://localhost:8080/realms/apiome  ' })).toBe(
      'http://localhost:8080/realms/apiome'
    );
  });

  test('oidcDisplayName returns trimmed OIDC_DISPLAY_NAME or null when unset', () => {
    expect(oidcDisplayName({})).toBeNull();
    expect(oidcDisplayName({ OIDC_DISPLAY_NAME: '   ' })).toBeNull();
    expect(oidcDisplayName({ OIDC_DISPLAY_NAME: '  Authentik  ' })).toBe('Authentik');
  });

  test('oidcScopes defaults to openid profile email when unset or blank', () => {
    expect(oidcScopes({})).toEqual([...OIDC_DEFAULT_SCOPES]);
    expect(oidcScopes({ OIDC_SCOPES: '   ' })).toEqual([...OIDC_DEFAULT_SCOPES]);
    expect(OIDC_DEFAULT_SCOPES).toEqual(['openid', 'profile', 'email']);
  });

  test('oidcScopes splits whitespace-separated OIDC_SCOPES', () => {
    expect(oidcScopes({ OIDC_SCOPES: 'openid email' })).toEqual(['openid', 'email']);
    expect(oidcScopes({ OIDC_SCOPES: '  openid   groups  profile  ' })).toEqual([
      'openid',
      'groups',
      'profile',
    ]);
  });

  test('oidc is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('oidc')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('oidc')).toBe(true);
  });
});

describe('probeOidcDiscovery', () => {
  const goodDoc = {
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
  };

  function mockFetch(
    impl: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  ): OidcDiscoveryFetch {
    return (url) => impl(url);
  }

  test('succeeds when discovery returns authorization_endpoint and token_endpoint', async () => {
    const fetchImpl = mockFetch(async (url) => {
      expect(url).toBe('https://auth.example.com/.well-known/openid-configuration');
      return { ok: true, status: 200, json: async () => goodDoc };
    });

    const result = await probeOidcDiscovery('https://auth.example.com/', fetchImpl);
    expect(result).toEqual({ ok: true });
  });

  test('fails when issuer is unset or blank', async () => {
    const result = await probeOidcDiscovery('   ', mockFetch(async () => ({ ok: true, status: 200, json: async () => goodDoc })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('issuer is unset or blank');
    }
  });

  test('fails when issuer is not a valid URL', async () => {
    const result = await probeOidcDiscovery('not-a-url', mockFetch(async () => ({ ok: true, status: 200, json: async () => goodDoc })));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('is not a valid URL');
    }
  });

  test('fails when issuer uses a non-http scheme', async () => {
    const result = await probeOidcDiscovery(
      'ftp://auth.example.com',
      mockFetch(async () => ({ ok: true, status: 200, json: async () => goodDoc }))
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('must use http or https');
    }
  });

  test('fails when discovery GET returns an HTTP error', async () => {
    const result = await probeOidcDiscovery(
      'https://auth.example.com',
      mockFetch(async () => ({ ok: false, status: 503, json: async () => null }))
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('returned HTTP 503');
    }
  });

  test('fails when discovery document is missing authorization_endpoint', async () => {
    const result = await probeOidcDiscovery(
      'https://auth.example.com',
      mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ token_endpoint: 'https://auth.example.com/token' }),
      }))
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('missing authorization_endpoint');
    }
  });

  test('fails when discovery document is missing token_endpoint', async () => {
    const result = await probeOidcDiscovery(
      'https://auth.example.com',
      mockFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ authorization_endpoint: 'https://auth.example.com/authorize' }),
      }))
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('missing token_endpoint');
    }
  });
});
