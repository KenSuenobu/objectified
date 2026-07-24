/**
 * Azure identity persistence tests (OLO-2.2, #4194).
 *
 * The azure (Microsoft Entra ID) identity must land in `apiome.external_auth_providers` with the
 * same token columns as the other providers, plus the claims a later pass needs to re-validate
 * the identity without a fresh sign-in: `oid`, `tid`, `upn`, `preferred_username`, `email`, and
 * the raw verified-email evidence (`email_verified`, `xms_edov`).
 *
 * Covered here:
 *   1. `extractIdentityDetails` — the azure claim capture (and that other providers are
 *      untouched by it).
 *   2. `resolveOAuthSignIn` end to end — what a real azure sign-in hands the store's
 *      `linkIdentity`, tokens and claims included.
 *   3. The provider vocabulary — `LINKABLE_PROVIDERS` accepts azure, and the link route
 *      (`api/auth/link/[provider]`) enforces it (source-level contract, matching the
 *      `tests/api` convention).
 */

import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import {
  extractIdentityDetails,
  resolveOAuthSignIn,
  LINKABLE_PROVIDERS,
  type OAuthIdentityDetails,
  type ResolutionStore,
  type ResolutionUser,
} from '../lib/auth/account-resolution';

// The resolution store (transitively imported by the resolution modules) opens a pg pool at import
// time; mock it away.
jest.mock('../lib/db/db', () => ({ query: jest.fn() }));

// `better-auth/api` is ESM-only; stub createAuthMiddleware to return the bare handler so
// `better-auth-account-resolution` (imported below for the OAuth vocabulary check) loads under ts-jest.
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
}));

/** A full Entra id-token claim set, verified via xms_edov. */
const ENTRA_CLAIMS = {
  oid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tid: '99999999-8888-7777-6666-555555555555',
  sub: 'per-app-subject',
  upn: 'ada@corp.example.com',
  preferred_username: 'ada@corp.example.com',
  email: 'ada@corp.example.com',
  email_verified: true,
  xms_edov: true,
  name: 'Ada Lovelace',
};

/** NextAuth signIn payload as the azure provider produces it (see entra-provider.test.ts). */
const ENTRA_PAYLOAD = {
  user: { id: ENTRA_CLAIMS.oid, name: ENTRA_CLAIMS.name, email: ENTRA_CLAIMS.email, image: null },
  account: {
    provider: 'azure',
    providerAccountId: ENTRA_CLAIMS.oid,
    access_token: 'azure-access-token',
    refresh_token: 'azure-refresh-token',
    expires_at: 1_760_000_000,
  },
  profile: ENTRA_CLAIMS,
};

// ---------------------------------------------------------------------------
// 1. Claim capture in extractIdentityDetails
// ---------------------------------------------------------------------------

describe('extractIdentityDetails — azure claim capture', () => {
  test('persists the re-validation claims and raw verified-email evidence in profile_data', () => {
    const details = extractIdentityDetails('azure', ENTRA_PAYLOAD, ENTRA_CLAIMS.email, true);

    expect(details.profileData).toMatchObject({
      oid: ENTRA_CLAIMS.oid,
      tid: ENTRA_CLAIMS.tid,
      upn: ENTRA_CLAIMS.upn,
      preferred_username: ENTRA_CLAIMS.preferred_username,
      email: ENTRA_CLAIMS.email,
      email_verified: true,
      xms_edov: true,
      name: ENTRA_CLAIMS.name,
    });
  });

  test('stores raw evidence as asserted — an explicit false is preserved, not normalized away', () => {
    const payload = {
      ...ENTRA_PAYLOAD,
      profile: { ...ENTRA_CLAIMS, email_verified: false, xms_edov: 0 },
    };
    const details = extractIdentityDetails('azure', payload, ENTRA_CLAIMS.email, false);

    expect(details.profileData.email_verified).toBe(false);
    expect(details.profileData.xms_edov).toBe(0);
  });

  test('claims the token did not carry are stored as null (explicit shape for re-validation reads)', () => {
    const payload = {
      user: { id: 'oid-only' },
      account: { provider: 'azure', providerAccountId: 'oid-only' },
      profile: { oid: 'oid-only' },
    };
    const details = extractIdentityDetails('azure', payload, null, false);

    expect(details.profileData).toMatchObject({
      oid: 'oid-only',
      tid: null,
      upn: null,
      preferred_username: null,
      email: null,
      email_verified: null,
      xms_edov: null,
    });
  });

  test('maps preferred_username onto provider_username (Entra has no login/username field)', () => {
    const details = extractIdentityDetails('azure', ENTRA_PAYLOAD, ENTRA_CLAIMS.email, true);
    expect(details.username).toBe(ENTRA_CLAIMS.preferred_username);
  });

  test('stores token-refresh data consistently with other providers', () => {
    const details = extractIdentityDetails('azure', ENTRA_PAYLOAD, ENTRA_CLAIMS.email, true);

    expect(details.accessToken).toBe('azure-access-token');
    expect(details.refreshToken).toBe('azure-refresh-token');
    expect(details.tokenExpiresAt).toEqual(new Date(1_760_000_000 * 1000));
  });

  test('non-azure providers keep their existing profile_data shape (no azure claim keys)', () => {
    const githubPayload = {
      user: { id: '123' },
      account: { provider: 'github', providerAccountId: '123', access_token: 'gh-token' },
      profile: {
        id: 123,
        login: 'ada',
        name: 'Ada',
        avatar_url: 'https://avatars.example/ada',
        html_url: 'https://github.com/ada',
        // A hostile/odd github profile carrying entra-looking keys must not change the shape:
        oid: 'not-an-entra-token',
      },
    };
    const details = extractIdentityDetails('github', githubPayload, 'ada@example.com', false);

    expect(details.username).toBe('ada');
    expect(details.profileData).not.toHaveProperty('oid');
    expect(details.profileData).not.toHaveProperty('xms_edov');
    expect(details.profileData).toMatchObject({
      name: 'Ada',
      avatar_url: 'https://avatars.example/ada',
      profile_url: 'https://github.com/ada',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. End to end: what the store persists on a real azure sign-in
// ---------------------------------------------------------------------------

const ADA_USER: ResolutionUser = {
  id: 'user-ada',
  enabled: true,
  verified: true,
  email: 'ada@corp.example.com',
  name: 'Ada',
};

/** In-memory store capturing what the engine persists. */
function makeStore(usersByEmail: Record<string, ResolutionUser>) {
  const linked: Array<{ userId: string; identity: OAuthIdentityDetails }> = [];
  const store: ResolutionStore = {
    async getIdentity() {
      return { found: false, userId: null };
    },
    async getUserById() {
      return null;
    },
    async getUserByEmail(email) {
      return usersByEmail[email] ?? null;
    },
    async linkIdentity(userId, identity) {
      linked.push({ userId, identity });
      return { success: true };
    },
    async recordIdentityLogin() {},
    async recordUserLogin() {},
    async createPendingSignup() {
      return { id: 'pending-1' };
    },
  };
  return { store, linked };
}

describe('azure sign-in persists a correct identity row (acceptance criterion)', () => {
  test('auto-link writes (azure, oid) with tokens and re-validation claims', async () => {
    const { store, linked } = makeStore({ 'ada@corp.example.com': ADA_USER });

    const result = await resolveOAuthSignIn(
      'azure',
      { ...ENTRA_PAYLOAD, user: { ...ENTRA_PAYLOAD.user } },
      null,
      store
    );

    expect(result).toBe(true);
    expect(linked).toHaveLength(1);
    expect(linked[0].userId).toBe(ADA_USER.id);
    expect(linked[0].identity).toMatchObject({
      provider: 'azure',
      providerUserId: ENTRA_CLAIMS.oid,
      email: 'ada@corp.example.com',
      emailVerified: true,
      username: ENTRA_CLAIMS.preferred_username,
      accessToken: 'azure-access-token',
      refreshToken: 'azure-refresh-token',
      tokenExpiresAt: new Date(1_760_000_000 * 1000),
    });
    expect(linked[0].identity.profileData).toMatchObject({
      oid: ENTRA_CLAIMS.oid,
      tid: ENTRA_CLAIMS.tid,
      upn: ENTRA_CLAIMS.upn,
      email_verified: true,
      xms_edov: true,
    });
  });

  test('explicit link-to-session flow persists the same azure identity details', async () => {
    const { store, linked } = makeStore({});

    const result = await resolveOAuthSignIn(
      'azure',
      { ...ENTRA_PAYLOAD, user: { ...ENTRA_PAYLOAD.user } },
      'session-user-1',
      store
    );

    expect(result).toBe('/ade/dashboard/linked-accounts?linked=true');
    expect(linked).toHaveLength(1);
    expect(linked[0].userId).toBe('session-user-1');
    expect(linked[0].identity.provider).toBe('azure');
    expect(linked[0].identity.providerUserId).toBe(ENTRA_CLAIMS.oid);
    expect(linked[0].identity.profileData).toMatchObject({ tid: ENTRA_CLAIMS.tid });
  });
});

// ---------------------------------------------------------------------------
// 3. Provider vocabulary + link-route contract
// ---------------------------------------------------------------------------

describe('linkable-provider vocabulary', () => {
  test('azure is linkable alongside github and gitlab; credentials is not an identity', () => {
    expect(LINKABLE_PROVIDERS.has('azure')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('github')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('gitlab')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('credentials')).toBe(false);
    expect(LINKABLE_PROVIDERS.has('azure-ad')).toBe(false);
  });

  test('every linkable provider is within the V181 DB vocabulary', () => {
    // The check constraint pinned by V181__provider_identity_uniqueness_4187.sql.
    const dbVocabulary = new Set(['github', 'gitlab', 'azure', 'aws', 'gcp', 'bitbucket', 'google']);
    for (const provider of LINKABLE_PROVIDERS) {
      expect(dbVocabulary.has(provider)).toBe(true);
    }
  });

  test('the OAuth sign-in dispatch supports exactly the linkable providers', async () => {
    // Credentials are handled by the Better Auth `emailAndPassword` path, not the OAuth dispatch, so
    // the OAuth vocabulary is exactly `LINKABLE_PROVIDERS` (no `credentials`).
    const { SUPPORTED_OAUTH_PROVIDERS } = await import('../lib/auth/better-auth-account-resolution');
    expect(SUPPORTED_OAUTH_PROVIDERS.size).toBe(LINKABLE_PROVIDERS.size);
    expect(SUPPORTED_OAUTH_PROVIDERS.has('credentials')).toBe(false);
    for (const provider of LINKABLE_PROVIDERS) {
      expect(SUPPORTED_OAUTH_PROVIDERS.has(provider)).toBe(true);
    }
  });
});

describe('link route (api/auth/link/[provider]) — source-level contract', () => {
  const ROUTE = path.resolve(
    __dirname,
    '..',
    'src',
    'app',
    'api',
    'auth',
    'link',
    '[provider]',
    'route.ts'
  );
  const src = fs.readFileSync(ROUTE, 'utf8');

  test('validates the slug against the shared LINKABLE_PROVIDERS vocabulary', () => {
    expect(src).toContain('LINKABLE_PROVIDERS');
    expect(src).toMatch(/LINKABLE_PROVIDERS\.has\(provider\)/);
  });

  test('gates every provider on the deployment enabling it (provider registry, OLO-2.3)', () => {
    // Since OLO-2.3 the azure-specific isEntraIdConfigured gate generalized to the registry:
    // github/gitlab/azure all require their env config before a link flow can start.
    expect(src).toContain('isProviderEnabled');
    expect(src).toMatch(/LINKABLE_PROVIDERS\.has\(provider\) && isProviderEnabled\(provider\)/);
  });

  test('refuses unknown/unconfigured providers with 400 and the stable contract code', () => {
    expect(src).toContain('AUTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED');
    expect(src).toMatch(/status:\s*400/);
  });

  test('still requires an authenticated session before setting the linking-intent cookie', () => {
    expect(src).toMatch(/status:\s*401/);
    expect(src).toContain("oauth_link_intent");
  });
});
