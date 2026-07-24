/**
 * Microsoft Entra ID provider-helper tests (OLO-2.1, #4193) for `lib/auth/entra-provider.ts`.
 *
 * Since the OLO-10.14 cutover this module is the engine-neutral core of Entra sign-in — the provider
 * slug, the OIDC authority base URL, the config-detection check, and the id-token claim mapping —
 * consumed by the Better Auth generic-OIDC provider (`better-auth-oauth-providers.ts`). Each helper's
 * guarantee is directly assertable:
 *
 *   1. Env contract — AZURE_AD_CLIENT_ID/SECRET gate whether Entra is configured.
 *   2. Authority base URL — defaults to the real Microsoft host; AZURE_AD_AUTHORITY_BASE_URL overrides
 *      it for the mocked-provider e2e journey (OLO-7.4), with the trailing slash trimmed.
 *   3. Identity contract — provider id is `azure` (the value the resolution engine's nOAuth gating and
 *      the external_auth_providers rows key on) and the profile maps the immutable `oid` claim to the
 *      user id (→ provider_user_id).
 *
 * The tenant-scoped OIDC discovery URL and the end-to-end nOAuth sign-in through the resolution engine
 * are covered on the live Better Auth path by `better-auth-oauth-providers.test.ts` (azure discovery +
 * nOAuth hardening) and `azure-identity-persistence.test.ts`.
 */

import { describe, test, expect } from '@jest/globals';

import {
  ENTRA_ID_PROVIDER_ID,
  entraAuthorityBaseUrl,
  entraIdProfile,
  isEntraIdConfigured,
} from '../lib/auth/entra-provider';
import { AUTO_LINK_TRUSTED_PROVIDERS } from '../lib/auth/account-resolution';

const CONFIGURED_ENV = {
  AZURE_AD_CLIENT_ID: 'client-id-123',
  AZURE_AD_CLIENT_SECRET: 'secret-456',
};

// ---------------------------------------------------------------------------
// 1. Env contract
// ---------------------------------------------------------------------------

describe('isEntraIdConfigured', () => {
  test('unset, blank, or partial credentials mean not configured', () => {
    expect(isEntraIdConfigured({})).toBe(false);
    expect(isEntraIdConfigured({ AZURE_AD_CLIENT_ID: 'id-only' })).toBe(false);
    expect(isEntraIdConfigured({ AZURE_AD_CLIENT_SECRET: 'secret-only' })).toBe(false);
    expect(
      isEntraIdConfigured({ AZURE_AD_CLIENT_ID: '   ', AZURE_AD_CLIENT_SECRET: 'x' })
    ).toBe(false);
  });

  test('both credentials present means configured', () => {
    expect(isEntraIdConfigured(CONFIGURED_ENV)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Authority base URL
// ---------------------------------------------------------------------------

describe('entraAuthorityBaseUrl', () => {
  test('defaults to the real Microsoft authority host', () => {
    expect(entraAuthorityBaseUrl({})).toBe('https://login.microsoftonline.com');
  });

  test('AZURE_AD_AUTHORITY_BASE_URL overrides it (OLO-7.4), trailing slash trimmed', () => {
    expect(entraAuthorityBaseUrl({ AZURE_AD_AUTHORITY_BASE_URL: 'http://localhost:8091/azure/' })).toBe(
      'http://localhost:8091/azure'
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Identity contract
// ---------------------------------------------------------------------------

describe('provider identity contract', () => {
  test('the provider id is `azure` — the value every OLO seam keys on', () => {
    expect(ENTRA_ID_PROVIDER_ID).toBe('azure');
  });

  test('`azure` is on the auto-link trust list, so the OLO-1.4 gating actually applies', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has(ENTRA_ID_PROVIDER_ID)).toBe(true);
  });

  test('profile maps the immutable oid — not sub — to the user id', () => {
    const user = entraIdProfile({
      oid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sub: 'per-app-subject',
      name: 'Ada Lovelace',
      email: 'ada@corp.example.com',
    });
    expect(user).toEqual({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'Ada Lovelace',
      email: 'ada@corp.example.com',
      image: null,
    });
  });

  test('profile falls back to sub only when the token carries no oid', () => {
    expect(entraIdProfile({ sub: 'per-app-subject' }).id).toBe('per-app-subject');
  });

  test('profile falls back to preferred_username for the display name', () => {
    expect(entraIdProfile({ oid: 'o-1', preferred_username: 'ada@corp.example.com' }).name).toBe(
      'ada@corp.example.com'
    );
  });

  test('a claim-free token maps to empty id and null fields (rejected later as incomplete)', () => {
    expect(entraIdProfile({})).toEqual({ id: '', name: null, email: null, image: null });
  });
});
