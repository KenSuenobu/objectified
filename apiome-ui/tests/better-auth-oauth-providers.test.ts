/**
 * @jest-environment node
 *
 * Better Auth OAuth provider construction tests (OLO-10.7, #5002).
 *
 * The acceptance gate for porting github/gitlab/azure/google onto Better Auth's generic OAuth2/OIDC
 * plugin. These tests prove the wiring re-attaches every invariant the NextAuth path guarantees,
 * without a database or network:
 *
 *   - the provider set is built from the shared registry (single source of the enabled set), in
 *     display order, with the client credentials and endpoint/issuer overrides (OLO-7.4) honoured;
 *   - each provider's `getUserInfo` normalizes `email_verified` the same way (GitHub `/user/emails`,
 *     GitLab `confirmed_at`, Google's native claim — OLO-2.5) before the resolution engine runs;
 *   - the Google Workspace `hd` gate still rejects an out-of-domain account (OLO-9.2);
 *   - a forged nOAuth (azure) token is still rejected with the structured code (OLO-1.4), and the
 *     full decision tree (admit / onboarding / link / reject) drives the redirect override;
 *   - the request-scoped redirect override rewrites the Better Auth callback's `Location`.
 *
 * The pure resolution engine and the 10.6 adapter are exercised by their own suites; here we only
 * assert the provider layer feeds them faithfully. `better-auth/api` (ESM-only) is stubbed and the
 * db-backed store is mocked away, matching `better-auth-account-resolution.test.ts`.
 */

// `better-auth/api` is ESM-only (imported transitively via the 10.6 adapter); stub the middleware
// factory to the bare handler so the module loads under ts-jest.
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
}));

// The default production store imports the db layer; every test injects a fake store, so replace the
// default with an inert stub to keep the suite hermetic.
jest.mock('../lib/auth/resolution-store', () => ({ resolutionStore: {} }));

// `resolveLinkIntentUserId` lazily imports `./oauth-link-intent` (which reads `next/headers`) to read
// the one-shot link-intent cookie. Stub it to "no link intent" so the default path stays hermetic; the
// explicit-link test injects its own `resolveLinkToUserId`.
jest.mock('../lib/auth/oauth-link-intent', () => ({ checkLinkingIntent: async () => null }));

import { describe, test, expect } from '@jest/globals';

import { AUTH_ERROR_CODES, type ResolutionStore, type ResolutionUser } from '../lib/auth/account-resolution';
import {
  applyOauthRedirectOverride,
  buildGenericOAuthConfig,
  buildGenericOAuthConfigs,
  decodeJwtClaims,
  getOauthRedirectOverride,
  githubOauthWebBaseUrl,
  makeOAuthGetUserInfo,
  runWithOauthRedirectOverride,
  type FetchLike,
  type OAuthRunnerDeps,
} from '../lib/auth/better-auth-oauth-providers';

/* ── Fixtures & fakes ──────────────────────────────────────────────────────────────────────── */

const ALL_ENABLED: Record<string, string> = {
  GITHUB_ID: 'gh-id',
  GITHUB_SECRET: 'gh-secret',
  GITLAB_CLIENT_ID: 'gl-id',
  GITLAB_CLIENT_SECRET: 'gl-secret',
  AZURE_AD_CLIENT_ID: 'az-id',
  AZURE_AD_CLIENT_SECRET: 'az-secret',
  GOOGLE_CLIENT_ID: 'go-id',
  GOOGLE_CLIENT_SECRET: 'go-secret',
};

const OK_USER: ResolutionUser = {
  id: 'user-ok',
  enabled: true,
  verified: true,
  email: 'ada@example.com',
  name: 'Ada',
};

interface StoreConfig {
  identityUserId?: string | null;
  usersById?: Record<string, ResolutionUser>;
  usersByEmail?: Record<string, ResolutionUser>;
}

function makeStore(config: StoreConfig = {}) {
  const calls = {
    linkIdentity: [] as Array<{ userId: string; identity: any }>,
    recordUserLogin: [] as string[],
    createPendingSignup: [] as any[],
  };
  const store: ResolutionStore = {
    async getIdentity() {
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
      return { success: true };
    },
    async recordIdentityLogin() {},
    async recordUserLogin(userId) {
      calls.recordUserLogin.push(userId);
    },
    async createPendingSignup(provider, providerUserId, email) {
      calls.createPendingSignup.push({ provider, providerUserId, email });
      return { id: 'pending-1' };
    },
  };
  return { store, calls };
}

/** base64url-encode a JWT segment. */
const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Build a signature-less JWT carrying `claims` in the payload (the gate never verifies the sig). */
const idTokenFor = (claims: Record<string, unknown>): string => `e30.${b64url(claims)}.sig`;

/**
 * A fetch stub that routes GitHub/GitLab userinfo calls by URL suffix. `profile` answers `/user`
 * and `/api/v4/user`; `emails` answers `/user/emails`. A route with no fixture returns `ok:false`.
 */
function makeFetch(routes: { profile?: unknown; emails?: unknown }): FetchLike {
  return async (url: string) => {
    if (url.endsWith('/user/emails')) {
      return routes.emails === undefined
        ? { ok: false, json: async () => null }
        : { ok: true, json: async () => routes.emails };
    }
    if (url.endsWith('/user') || url.endsWith('/api/v4/user')) {
      return routes.profile === undefined
        ? { ok: false, json: async () => null }
        : { ok: true, json: async () => routes.profile };
    }
    return { ok: false, json: async () => null };
  };
}

/** Run a provider's getUserInfo inside a redirect-override scope and return the result + override. */
async function runGetUserInfo(
  provider: string,
  tokens: Record<string, unknown>,
  deps: OAuthRunnerDeps
): Promise<{ result: any; override: string | null }> {
  return runWithOauthRedirectOverride(async () => {
    const result = await makeOAuthGetUserInfo(provider, deps)(tokens as any);
    return { result, override: getOauthRedirectOverride() };
  });
}

/* ── Config builder from the registry ──────────────────────────────────────────────────────── */

describe('buildGenericOAuthConfigs — registry is the single source of the enabled set', () => {
  test('builds one config per enabled provider, in registry display order; aws (coming-soon) omitted', () => {
    const configs = buildGenericOAuthConfigs(ALL_ENABLED);
    expect(configs.map((c) => c.providerId)).toEqual(['github', 'gitlab', 'azure', 'google']);
  });

  test('unsetting a provider env removes exactly that provider', () => {
    const env = { ...ALL_ENABLED };
    delete env.GITHUB_SECRET; // github now partially configured → not enabled
    expect(buildGenericOAuthConfigs(env).map((c) => c.providerId)).toEqual([
      'gitlab',
      'azure',
      'google',
    ]);
  });

  test('no providers configured → empty config list (no sign-in routes)', () => {
    expect(buildGenericOAuthConfigs({})).toEqual([]);
  });

  test('client id/secret are read from the registry env keys', () => {
    const github = buildGenericOAuthConfig('github', ALL_ENABLED)!;
    expect(github.clientId).toBe('gh-id');
    expect(github.clientSecret).toBe('gh-secret');
    const azure = buildGenericOAuthConfig('azure', ALL_ENABLED)!;
    expect(azure.clientId).toBe('az-id');
    expect(azure.clientSecret).toBe('az-secret');
  });

  test('an unknown provider id yields null', () => {
    expect(buildGenericOAuthConfig('okta', ALL_ENABLED)).toBeNull();
  });
});

/* ── Endpoint / issuer overrides (OLO-7.4) ─────────────────────────────────────────────────── */

describe('endpoint & issuer overrides (OLO-7.4)', () => {
  test('github: default hosts, and GITHUB_OAUTH_BASE_URL / GITHUB_API_BASE_URL overrides', () => {
    const def = buildGenericOAuthConfig('github', ALL_ENABLED)!;
    expect(def.authorizationUrl).toBe('https://github.com/login/oauth/authorize');
    expect(def.tokenUrl).toBe('https://github.com/login/oauth/access_token');
    expect(def.userInfoUrl).toBe('https://api.github.com/user');
    expect(def.pkce).toBe(false); // GitHub OAuth Apps do not support PKCE

    const mock = buildGenericOAuthConfig('github', {
      ...ALL_ENABLED,
      GITHUB_OAUTH_BASE_URL: 'http://localhost:9001/',
      GITHUB_API_BASE_URL: 'http://localhost:9002',
    })!;
    expect(mock.authorizationUrl).toBe('http://localhost:9001/login/oauth/authorize');
    expect(mock.tokenUrl).toBe('http://localhost:9001/login/oauth/access_token');
    expect(mock.userInfoUrl).toBe('http://localhost:9002/user');
  });

  test('gitlab: GITLAB_BASE_URL override drives authorize/token/userinfo; PKCE on', () => {
    const cfg = buildGenericOAuthConfig('gitlab', {
      ...ALL_ENABLED,
      GITLAB_BASE_URL: 'http://localhost:9003',
    })!;
    expect(cfg.authorizationUrl).toBe('http://localhost:9003/oauth/authorize');
    expect(cfg.tokenUrl).toBe('http://localhost:9003/oauth/token');
    expect(cfg.userInfoUrl).toBe('http://localhost:9003/api/v4/user');
    expect(cfg.pkce).toBe(true);
  });

  test('google: GOOGLE_ISSUER override drives OIDC discovery', () => {
    expect(buildGenericOAuthConfig('google', ALL_ENABLED)!.discoveryUrl).toBe(
      'https://accounts.google.com/.well-known/openid-configuration'
    );
    expect(
      buildGenericOAuthConfig('google', { ...ALL_ENABLED, GOOGLE_ISSUER: 'http://localhost:9004' })!
        .discoveryUrl
    ).toBe('http://localhost:9004/.well-known/openid-configuration');
  });

  test('azure: authority + tenant drive tenant-scoped OIDC discovery', () => {
    expect(buildGenericOAuthConfig('azure', ALL_ENABLED)!.discoveryUrl).toBe(
      'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration'
    );
    const scoped = buildGenericOAuthConfig('azure', {
      ...ALL_ENABLED,
      AZURE_AD_TENANT: 'contoso',
      AZURE_AD_AUTHORITY_BASE_URL: 'http://localhost:9005',
    })!;
    expect(scoped.discoveryUrl).toBe(
      'http://localhost:9005/contoso/v2.0/.well-known/openid-configuration'
    );
    expect(scoped.scopes).toContain('offline_access');
  });

  test('githubOauthWebBaseUrl strips a trailing slash', () => {
    expect(githubOauthWebBaseUrl({ GITHUB_OAUTH_BASE_URL: 'http://mock/' })).toBe('http://mock');
    expect(githubOauthWebBaseUrl({})).toBe('https://github.com');
  });
});

/* ── decodeJwtClaims ───────────────────────────────────────────────────────────────────────── */

describe('decodeJwtClaims', () => {
  test('decodes the payload segment; fails soft to null on malformed input', () => {
    expect(decodeJwtClaims(idTokenFor({ sub: 'abc', email: 'a@b.com' }))).toMatchObject({
      sub: 'abc',
      email: 'a@b.com',
    });
    expect(decodeJwtClaims(null)).toBeNull();
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
    expect(decodeJwtClaims('a.%%%.c')).toBeNull();
  });
});

/* ── getUserInfo: GitHub/GitLab verified-email parity (OLO-2.5) ─────────────────────────────── */

describe('getUserInfo — GitHub verified-email parity', () => {
  const tokens = { accessToken: 'tok', idToken: null };

  test('known identity with a verified primary email → admits with the resolved user info', async () => {
    const { store, calls } = makeStore({ identityUserId: OK_USER.id, usersById: { [OK_USER.id]: OK_USER } });
    const fetchImpl = makeFetch({
      profile: { id: 42, login: 'ada', name: 'Ada L.', email: null, avatar_url: 'http://img/a.png' },
      emails: [{ email: 'ada@example.com', primary: true, verified: true }],
    });

    const { result, override } = await runGetUserInfo('github', tokens, { store, fetchImpl });

    expect(override).toBeNull();
    expect(result).toMatchObject({
      id: '42',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada L.',
      image: 'http://img/a.png',
    });
    expect(calls.recordUserLogin).toEqual([OK_USER.id]);
  });

  test('an unverified GitHub email is rejected with the structured code, no user info', async () => {
    const { store } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
    const fetchImpl = makeFetch({
      profile: { id: 42, login: 'ada', email: 'ada@example.com' },
      emails: [{ email: 'ada@example.com', primary: true, verified: false }],
    });

    const { result, override } = await runGetUserInfo('github', tokens, { store, fetchImpl });

    expect(result).toBeNull();
    expect(override).toBe(`/login?error=${AUTH_ERROR_CODES.UNVERIFIED_EMAIL}`);
  });

  test('a verified new email routes to onboarding (no auto-create)', async () => {
    const { store, calls } = makeStore();
    const fetchImpl = makeFetch({
      profile: { id: 42, login: 'ada', email: 'ada@example.com' },
      emails: [{ email: 'ada@example.com', primary: true, verified: true }],
    });

    const { result, override } = await runGetUserInfo('github', tokens, { store, fetchImpl });

    expect(result).toBeNull();
    expect(override).toBe('/signup/oauth?token=pending-1');
    expect(calls.createPendingSignup[0]).toMatchObject({ provider: 'github', email: 'ada@example.com' });
  });
});

describe('getUserInfo — GitLab verified-email parity', () => {
  const tokens = { accessToken: 'tok', idToken: null };

  test('confirmed_at present → verified → onboarding for a new user', async () => {
    const { store } = makeStore();
    const fetchImpl = makeFetch({
      profile: { id: 7, username: 'ada', name: 'Ada', email: 'ada@example.com', confirmed_at: '2021-01-01T00:00:00Z' },
    });

    const { result, override } = await runGetUserInfo('gitlab', tokens, { store, fetchImpl });

    expect(result).toBeNull();
    expect(override).toBe('/signup/oauth?token=pending-1');
  });

  test('missing confirmed_at → unverified → structured rejection', async () => {
    const { store } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
    const fetchImpl = makeFetch({ profile: { id: 7, email: 'ada@example.com' } });

    const { result, override } = await runGetUserInfo('gitlab', tokens, { store, fetchImpl });

    expect(result).toBeNull();
    expect(override).toBe(`/login?error=${AUTH_ERROR_CODES.UNVERIFIED_EMAIL}`);
  });
});

/* ── getUserInfo: Google native email_verified + hd gate (OLO-9.2) ──────────────────────────── */

describe('getUserInfo — Google Workspace hd gate (OLO-9.2)', () => {
  test('native email_verified=true, unrestricted → onboarding for a new verified user', async () => {
    const { store } = makeStore();
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({ sub: 'g-1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
    };

    const { result, override } = await runGetUserInfo('google', tokens, { store, env: ALL_ENABLED });

    expect(result).toBeNull();
    expect(override).toBe('/signup/oauth?token=pending-1');
  });

  test('matching hd passes the gate → a known identity signs in', async () => {
    const { store } = makeStore({ identityUserId: OK_USER.id, usersById: { [OK_USER.id]: OK_USER } });
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({ sub: 'g-1', email: 'ada@corp.com', email_verified: true, hd: 'corp.com' }),
    };

    const { result, override } = await runGetUserInfo('google', tokens, {
      store,
      env: { ...ALL_ENABLED, GOOGLE_WORKSPACE_DOMAIN: 'corp.com' },
    });

    expect(override).toBeNull();
    expect(result).toMatchObject({ id: 'g-1', email: 'ada@corp.com', emailVerified: true });
  });

  test('out-of-domain hd is rejected before resolution — the epic acceptance criterion', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@corp.com': OK_USER } });
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({ sub: 'g-1', email: 'ada@corp.com', email_verified: true, hd: 'evil.com' }),
    };

    const { result, override } = await runGetUserInfo('google', tokens, {
      store,
      env: { ...ALL_ENABLED, GOOGLE_WORKSPACE_DOMAIN: 'corp.com' },
    });

    expect(result).toBeNull();
    expect(override).toBe(`/login?error=${AUTH_ERROR_CODES.SIGN_IN_FAILED}`);
    // The gate fires before any store side effect — no link, no signup.
    expect(calls.linkIdentity).toHaveLength(0);
    expect(calls.createPendingSignup).toHaveLength(0);
  });

  test('a personal account (no hd) is rejected when a domain is configured', async () => {
    const { store } = makeStore();
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({ sub: 'g-1', email: 'ada@gmail.com', email_verified: true }),
    };

    const { result, override } = await runGetUserInfo('google', tokens, {
      store,
      env: { ...ALL_ENABLED, GOOGLE_WORKSPACE_DOMAIN: 'corp.com' },
    });

    expect(result).toBeNull();
    expect(override).toBe(`/login?error=${AUTH_ERROR_CODES.SIGN_IN_FAILED}`);
  });
});

/* ── getUserInfo: azure nOAuth hardening (OLO-1.4) ─────────────────────────────────────────── */

describe('getUserInfo — azure nOAuth hardening (OLO-1.4)', () => {
  test('forged token (guest upn, no evidence) is rejected with unverified-email', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'victim@corp.com': OK_USER } });
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({
        oid: 'aad-oid',
        email: 'victim@corp.com',
        upn: 'attacker#EXT#@evil.onmicrosoft.com',
        name: 'Mallory',
      }),
    };

    const { result, override } = await runGetUserInfo('azure', tokens, { store });

    expect(result).toBeNull();
    expect(override).toBe(`/login?error=${AUTH_ERROR_CODES.UNVERIFIED_EMAIL}`);
    expect(calls.linkIdentity).toHaveLength(0);
    expect(calls.recordUserLogin).toHaveLength(0);
  });

  test('xms_edov=true verifies the email → auto-links an existing account and admits', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'user@corp.com': OK_USER } });
    const tokens = {
      accessToken: 'tok',
      idToken: idTokenFor({ oid: 'aad-oid', email: 'user@corp.com', xms_edov: true, name: 'User' }),
    };

    const { result, override } = await runGetUserInfo('azure', tokens, { store });

    expect(override).toBeNull();
    expect(result).toMatchObject({ id: 'aad-oid', email: 'user@corp.com', emailVerified: true });
    expect(calls.linkIdentity).toHaveLength(1);
    expect(calls.linkIdentity[0].userId).toBe(OK_USER.id);
  });
});

/* ── Explicit link intent ──────────────────────────────────────────────────────────────────── */

describe('getUserInfo — explicit link intent', () => {
  test('a link-intent user id attaches the identity even with an unverified email', async () => {
    const { store, calls } = makeStore();
    const fetchImpl = makeFetch({ profile: { id: 7, email: 'ada@example.com' } }); // gitlab, no confirmed_at

    const { result, override } = await runGetUserInfo(
      'gitlab',
      { accessToken: 'tok', idToken: null },
      { store, fetchImpl, resolveLinkToUserId: async () => 'session-user' }
    );

    expect(result).toBeNull();
    expect(override).toBe('/ade/dashboard/linked-accounts?linked=true');
    expect(calls.linkIdentity[0].userId).toBe('session-user');
  });
});

/* ── Redirect-override transport ───────────────────────────────────────────────────────────── */

describe('applyOauthRedirectOverride', () => {
  test('rewrites the Location of a redirect response when an override was published', async () => {
    const rewritten = await runWithOauthRedirectOverride(async () => {
      const { store } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
      const fetchImpl = makeFetch({
        profile: { id: 42, email: 'ada@example.com' },
        emails: [{ email: 'ada@example.com', primary: true, verified: false }],
      });
      await makeOAuthGetUserInfo('github', { store, fetchImpl })({ accessToken: 'tok', idToken: null } as any);

      const response = new Response(null, { status: 302, headers: { Location: '/callback/github' } });
      return applyOauthRedirectOverride(response);
    });

    expect(rewritten.status).toBe(302);
    expect(rewritten.headers.get('Location')).toBe(`/login?error=${AUTH_ERROR_CODES.UNVERIFIED_EMAIL}`);
  });

  test('leaves a redirect untouched when the sign-in was admitted (no override)', async () => {
    const untouched = await runWithOauthRedirectOverride(async () => {
      const response = new Response(null, { status: 302, headers: { Location: '/dashboard' } });
      return applyOauthRedirectOverride(response);
    });
    expect(untouched.headers.get('Location')).toBe('/dashboard');
  });

  test('leaves a non-redirect (200) response untouched even with an override set', async () => {
    const untouched = await runWithOauthRedirectOverride(async () => {
      const response = new Response('ok', { status: 200, headers: { Location: '/x' } });
      // publish an override, then confirm a 200 is not rewritten
      const { store } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });
      const fetchImpl = makeFetch({
        profile: { id: 42, email: 'ada@example.com' },
        emails: [{ email: 'ada@example.com', primary: true, verified: false }],
      });
      await makeOAuthGetUserInfo('github', { store, fetchImpl })({ accessToken: 'tok', idToken: null } as any);
      return applyOauthRedirectOverride(response);
    });
    expect(untouched.status).toBe(200);
    expect(untouched.headers.get('Location')).toBe('/x');
  });

  test('outside a scope the override is inert (getUserInfo still returns its outcome)', async () => {
    const { store } = makeStore({ identityUserId: OK_USER.id, usersById: { [OK_USER.id]: OK_USER } });
    const fetchImpl = makeFetch({
      profile: { id: 42, email: 'ada@example.com' },
      emails: [{ email: 'ada@example.com', primary: true, verified: true }],
    });
    // No runWithOauthRedirectOverride wrapper: setOauthRedirectOverride no-ops, result still returned.
    const result = await makeOAuthGetUserInfo('github', { store, fetchImpl })({
      accessToken: 'tok',
      idToken: null,
    } as any);
    expect(result).toMatchObject({ id: '42', emailVerified: true });
    expect(getOauthRedirectOverride()).toBeNull();
  });
});
