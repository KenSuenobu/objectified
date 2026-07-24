/**
 * Better Auth account-resolution adapter tests (OLO-10.6, #5001).
 *
 * The acceptance gate for re-homing the security spine onto Better Auth: the same
 * account-resolution / nOAuth / verified-email policy must hold when the engine is driven from a
 * Better Auth OAuth callback context instead of a NextAuth `signIn` payload. These tests carry the
 * engine matrix over onto the adapter (`better-auth-account-resolution.ts`) and prove:
 *
 *   - the full decision tree (known identity → sign in; verified-email match → auto-link; verified
 *     new email → onboarding; unverified → structured rejection; explicit link intent),
 *   - a **forged nOAuth (azure) token is still rejected** with the structured `unverified-email`
 *     code, while acceptable Entra evidence (`xms_edov` / member `upn`) verifies (OLO-1.4),
 *   - GitHub/GitLab/Google verified-email parity through the adapter (OLO-2.5),
 *   - the context→payload mapping and the OAuth-callback hook gating.
 *
 * The pure engine is exercised directly by `account-resolution.test.ts`; here we only assert the
 * Better Auth wiring feeds it faithfully and preserves every outcome. A fake store keeps the suite
 * free of any database, and `resolution-store` (which imports the db layer) is mocked away so the
 * default store never pulls a connection.
 */

// `better-auth/api` is ESM-only; stub createAuthMiddleware to return the bare handler (matching
// `better-auth-credentials.test.ts`), so the adapter's `oauthResolutionHook` is directly callable.
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
}));

// The default production store imports the db layer; the adapter always takes an injected store in
// these tests, so replace it with an inert stub to keep the suite hermetic.
jest.mock('../lib/auth/resolution-store', () => ({ resolutionStore: {} }));

import { describe, test, expect } from '@jest/globals';

import {
  AUTH_ERROR_CODES,
  type ResolutionStore,
  type ResolutionUser,
} from '../lib/auth/account-resolution';
import {
  SUPPORTED_OAUTH_PROVIDERS,
  mapBetterAuthOAuthPayload,
  resolveBetterAuthOAuthSignIn,
  oauthProviderFromCallbackPath,
  oauthResolutionHandler,
  type BetterAuthOAuthContext,
} from '../lib/auth/better-auth-account-resolution';

const OK_USER: ResolutionUser = {
  id: 'user-ok',
  enabled: true,
  verified: true,
  email: 'ada@example.com',
  name: 'Ada',
};

// ---------------------------------------------------------------------------
// Fake store — mirrors the orchestration fake in account-resolution.test.ts.
// ---------------------------------------------------------------------------

interface StoreConfig {
  identityUserId?: string | null;
  usersById?: Record<string, ResolutionUser>;
  usersByEmail?: Record<string, ResolutionUser>;
  linkResult?: { success: boolean; code?: string };
  throwOnGetIdentity?: boolean;
}

function makeStore(config: StoreConfig = {}) {
  const calls = {
    linkIdentity: [] as Array<{ userId: string; identity: any }>,
    recordIdentityLogin: [] as any[],
    recordUserLogin: [] as string[],
    createPendingSignup: [] as any[],
  };
  const store: ResolutionStore = {
    async getIdentity() {
      if (config.throwOnGetIdentity) throw new Error('boom');
      return config.identityUserId !== undefined
        ? { found: true, userId: config.identityUserId }
        : { found: false, userId: null };
    },
    async getUserById(userId) {
      return config.usersById?.[userId] ?? null;
    },
    async getUserByEmail(email) {
      return config.usersByEmail?.[email] ?? null;
    },
    async linkIdentity(userId, identity) {
      calls.linkIdentity.push({ userId, identity });
      return (config.linkResult ?? { success: true }) as { success: boolean; code?: any };
    },
    async recordIdentityLogin(provider, providerUserId, email, emailVerified) {
      calls.recordIdentityLogin.push({ provider, providerUserId, email, emailVerified });
    },
    async recordUserLogin(userId) {
      calls.recordUserLogin.push(userId);
    },
    async createPendingSignup(provider, providerUserId, email, account, profile) {
      calls.createPendingSignup.push({ provider, providerUserId, email, account, profile });
      return { id: 'pending-1' };
    },
  };
  return { store, calls };
}

/** Build a Better Auth OAuth callback context for a GitHub-shaped verified sign-in. */
const makeCtx = (overrides: {
  accountId?: string | null;
  profile?: Record<string, any>;
  tokens?: Record<string, any>;
} = {}): BetterAuthOAuthContext => ({
  accountId: overrides.accountId === undefined ? 'prov-123' : overrides.accountId,
  profile: {
    email: 'Ada@Example.com',
    email_verified: true,
    login: 'ada',
    name: 'Ada L.',
    ...overrides.profile,
  },
  tokens: {
    accessToken: 'tok',
    refreshToken: null,
    accessTokenExpiresAt: new Date(1_700_000_000_000),
    ...overrides.tokens,
  },
});

// ---------------------------------------------------------------------------
// mapBetterAuthOAuthPayload — faithful context → engine payload
// ---------------------------------------------------------------------------

describe('mapBetterAuthOAuthPayload', () => {
  test('maps the stable id, tokens (expiry → epoch seconds), and passes the profile through', () => {
    const payload = mapBetterAuthOAuthPayload('github', makeCtx());
    expect(payload.account).toMatchObject({
      provider: 'github',
      providerAccountId: 'prov-123',
      access_token: 'tok',
      refresh_token: null,
      expires_at: 1_700_000_000, // Date(ms) → epoch seconds, matching the engine's expectation
      email_verified: true,
    });
    expect(payload.user).toEqual({ email: 'Ada@Example.com', name: 'Ada L.' });
    expect(payload.profile).toMatchObject({ email: 'Ada@Example.com', login: 'ada' });
  });

  test('falls back to profile.sub then profile.id for the provider account id', () => {
    expect(
      mapBetterAuthOAuthPayload('gitlab', makeCtx({ accountId: null, profile: { sub: 'sub-1' } })).account
        .providerAccountId
    ).toBe('sub-1');
    expect(
      mapBetterAuthOAuthPayload('gitlab', makeCtx({ accountId: null, profile: { id: 'id-1' } })).account
        .providerAccountId
    ).toBe('id-1');
  });

  test('accepts an epoch-seconds number expiry and null-safes a missing one', () => {
    expect(
      mapBetterAuthOAuthPayload('github', makeCtx({ tokens: { accessTokenExpiresAt: 1_700_000_000 } }))
        .account.expires_at
    ).toBe(1_700_000_000);
    expect(
      mapBetterAuthOAuthPayload('github', makeCtx({ tokens: { accessTokenExpiresAt: null } })).account
        .expires_at
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveBetterAuthOAuthSignIn — the decision tree over Better Auth wiring
// ---------------------------------------------------------------------------

describe('resolveBetterAuthOAuthSignIn — decision tree', () => {
  test('(a) known identity: signs in, refreshes the login stamps', async () => {
    const { store, calls } = makeStore({
      identityUserId: OK_USER.id,
      usersById: { [OK_USER.id]: OK_USER },
    });

    const result = await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store);

    expect(result).toBe(true);
    expect(calls.recordIdentityLogin).toEqual([
      { provider: 'github', providerUserId: 'prov-123', email: 'ada@example.com', emailVerified: true },
    ]);
    expect(calls.recordUserLogin).toEqual([OK_USER.id]);
    expect(calls.linkIdentity).toHaveLength(0);
  });

  test('(b) verified email match: auto-links the identity, then signs in', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });

    const result = await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store);

    expect(result).toBe(true);
    expect(calls.linkIdentity).toHaveLength(1);
    expect(calls.linkIdentity[0].userId).toBe(OK_USER.id);
    expect(calls.linkIdentity[0].identity).toMatchObject({
      provider: 'github',
      providerUserId: 'prov-123',
      email: 'ada@example.com',
      emailVerified: true,
      username: 'ada',
    });
  });

  test('(b) failed auto-link refuses the sign-in with the store code — never an unrecorded login', async () => {
    const { store, calls } = makeStore({
      usersByEmail: { 'ada@example.com': OK_USER },
      linkResult: { success: false, code: 'provider-already-linked' },
    });

    const result = await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store);

    expect(result).toBe('/login?error=provider-already-linked');
    expect(calls.recordUserLogin).toHaveLength(0);
  });

  test('(c) verified new email: persists a pending signup and redirects to onboarding', async () => {
    const { store, calls } = makeStore();

    const result = await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store);

    expect(result).toBe('/signup/oauth?token=pending-1');
    expect(calls.createPendingSignup).toHaveLength(1);
    expect(calls.createPendingSignup[0]).toMatchObject({
      provider: 'github',
      providerUserId: 'prov-123',
      email: 'ada@example.com',
    });
  });

  test('(d) unverified email: rejects with unverified-email and persists nothing', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });

    const result = await resolveBetterAuthOAuthSignIn(
      'github',
      makeCtx({ profile: { email_verified: false } }),
      null,
      store
    );

    expect(result).toBe('/login?error=unverified-email');
    expect(calls.linkIdentity).toHaveLength(0);
    expect(calls.createPendingSignup).toHaveLength(0);
  });

  test('explicit link intent attaches to the session user even with an unverified email', async () => {
    const { store, calls } = makeStore();

    const result = await resolveBetterAuthOAuthSignIn(
      'gitlab',
      makeCtx({ profile: { email_verified: false } }),
      'session-user',
      store
    );

    expect(result).toBe('/ade/dashboard/linked-accounts?linked=true');
    expect(calls.linkIdentity).toHaveLength(1);
    expect(calls.linkIdentity[0].userId).toBe('session-user');
  });

  test('missing provider email → email-required; missing account id → profile-incomplete', async () => {
    const { store } = makeStore();

    expect(
      await resolveBetterAuthOAuthSignIn('github', makeCtx({ profile: { email: null } }), null, store)
    ).toBe('/login?error=OAuthEmailRequired');
    expect(
      await resolveBetterAuthOAuthSignIn('github', makeCtx({ accountId: null, profile: { id: null } }), null, store)
    ).toBe('/login?error=OAuthProfileIncomplete');
  });

  test('an unsupported provider slug is refused with provider-not-configured', async () => {
    const { store } = makeStore();
    expect(await resolveBetterAuthOAuthSignIn('not-a-provider', makeCtx(), null, store)).toBe(
      '/login?error=provider-not-configured'
    );
  });

  test('a store fault is contained as a non-admit false — never a fall-through sign-in', async () => {
    const { store } = makeStore({ throwOnGetIdentity: true });
    expect(await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store)).toBe(false);
  });

  test('the adapter dispatches every trusted OAuth provider (and not credentials)', () => {
    expect([...SUPPORTED_OAUTH_PROVIDERS].sort()).toEqual([
      'auth0',
      'aws',
      'azure',
      'github',
      'gitlab',
      'google',
      'keycloak',
      'oidc',
      'okta',
    ]);
    expect(SUPPORTED_OAUTH_PROVIDERS.has('credentials')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nOAuth hardening (OLO-1.4) through the adapter — the epic acceptance criterion
// ---------------------------------------------------------------------------

describe('resolveBetterAuthOAuthSignIn — nOAuth (azure) hardening', () => {
  // An azure callback context. The default GitHub fixture stamps `email_verified: true`; Entra tokens
  // carry no such generic claim, so strip it — each test supplies the exact evidence (xms_edov /
  // email_verified / upn) it means to exercise. A "forged" token is simply one with no valid evidence.
  const azureCtx = (profile: Record<string, any>) =>
    makeCtx({ accountId: 'aad-oid', profile: { email_verified: undefined, ...profile } });

  test('forged token (arbitrary email, no evidence, guest upn) is rejected with unverified-email', async () => {
    // The victim already has an account; a forged nOAuth token must never auto-link to it.
    const { store, calls } = makeStore({ usersByEmail: { 'victim@corp.com': OK_USER } });

    const result = await resolveBetterAuthOAuthSignIn(
      'azure',
      azureCtx({
        email: 'victim@corp.com',
        upn: 'attacker#EXT#@evil.onmicrosoft.com',
        name: 'Mallory',
      }),
      null,
      store
    );

    expect(result).toBe('/login?error=unverified-email');
    expect(calls.linkIdentity).toHaveLength(0);
    expect(calls.recordUserLogin).toHaveLength(0);
  });

  test('an explicit-false email_verified claim vetoes even a matching upn', async () => {
    const { store } = makeStore({ usersByEmail: { 'user@corp.com': OK_USER } });
    const result = await resolveBetterAuthOAuthSignIn(
      'azure',
      azureCtx({ email: 'user@corp.com', upn: 'user@corp.com', email_verified: false }),
      null,
      store
    );
    expect(result).toBe('/login?error=unverified-email');
  });

  test('xms_edov=true verifies the token email → auto-links an existing account', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'user@corp.com': OK_USER } });

    const result = await resolveBetterAuthOAuthSignIn(
      'azure',
      azureCtx({ email: 'user@corp.com', xms_edov: true }),
      null,
      store
    );

    expect(result).toBe(true);
    expect(calls.linkIdentity).toHaveLength(1);
    expect(calls.linkIdentity[0].userId).toBe(OK_USER.id);
  });

  test('a member upn matching the email verifies → onboarding for a new user', async () => {
    const { store, calls } = makeStore();

    const result = await resolveBetterAuthOAuthSignIn(
      'azure',
      azureCtx({ email: 'user@corp.com', upn: 'user@corp.com' }),
      null,
      store
    );

    expect(result).toBe('/signup/oauth?token=pending-1');
    expect(calls.createPendingSignup[0]).toMatchObject({ provider: 'azure', email: 'user@corp.com' });
  });
});

// ---------------------------------------------------------------------------
// Verified-email parity (OLO-2.5) through the adapter
// ---------------------------------------------------------------------------

describe('resolveBetterAuthOAuthSignIn — verified-email parity', () => {
  for (const provider of ['github', 'gitlab', 'google']) {
    test(`${provider}: a normalized email_verified=true proceeds; false is rejected`, async () => {
      const verified = makeStore();
      expect(
        await resolveBetterAuthOAuthSignIn(provider, makeCtx({ profile: { email_verified: true } }), null, verified.store)
      ).toBe('/signup/oauth?token=pending-1');

      const unverified = makeStore();
      expect(
        await resolveBetterAuthOAuthSignIn(provider, makeCtx({ profile: { email_verified: false } }), null, unverified.store)
      ).toBe('/login?error=unverified-email');
    });
  }
});

// ---------------------------------------------------------------------------
// OAuth callback hook — path gating and redirect issuance
// ---------------------------------------------------------------------------

describe('oauthProviderFromCallbackPath', () => {
  test('extracts the slug from social and generic-OAuth callback paths', () => {
    expect(oauthProviderFromCallbackPath('/callback/github')).toBe('github');
    expect(oauthProviderFromCallbackPath('/oauth2/callback/azure')).toBe('azure');
    expect(oauthProviderFromCallbackPath('/callback/gitlab?code=abc')).toBe('gitlab');
  });

  test('returns null for non-callback paths, an empty slug, and non-strings', () => {
    expect(oauthProviderFromCallbackPath('/sign-in/email')).toBeNull();
    expect(oauthProviderFromCallbackPath('/callback/')).toBeNull();
    expect(oauthProviderFromCallbackPath(undefined)).toBeNull();
  });
});

describe('oauthResolutionHandler — OAuth callback hook', () => {
  test('no-ops when the request is not an OAuth callback (credential path)', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
    await expect(oauthResolutionHandler({ path: '/sign-in/email' }, store)).resolves.toBeUndefined();
    expect(calls.linkIdentity).toHaveLength(0);
  });

  test('no-ops on a callback path until the provider hook supplies ctx.oauth (inert pre-10.7)', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
    await expect(oauthResolutionHandler({ path: '/callback/github' }, store)).resolves.toBeUndefined();
    expect(calls.linkIdentity).toHaveLength(0);
  });

  test('admits a resolved sign-in without redirecting', async () => {
    const { store } = makeStore({ identityUserId: OK_USER.id, usersById: { [OK_USER.id]: OK_USER } });
    const ctx = {
      path: '/callback/github',
      oauth: makeCtx(),
      redirect: (url: string) => ({ redirectedTo: url }),
    };
    await expect(oauthResolutionHandler(ctx, store)).resolves.toBeUndefined();
  });

  test('issues the structured redirect for a rejection via ctx.redirect', async () => {
    const { store } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
    const ctx = {
      path: '/callback/github',
      oauth: makeCtx({ profile: { email_verified: false } }),
      redirect: (url: string) => ({ redirectedTo: url }),
    };
    await expect(oauthResolutionHandler(ctx, store)).rejects.toEqual({
      redirectedTo: `/login?error=${AUTH_ERROR_CODES.UNVERIFIED_EMAIL}`,
    });
  });
});
