/**
 * Wiring tests for the Better Auth core install (OLO-10.2): `lib/auth/auth.ts` (server instance +
 * request handler) and `lib/auth/auth-client.ts` (browser client).
 *
 * `better-auth` ships ESM-only, which ts-jest's CommonJS transform cannot `require`, so the package
 * (and the Postgres pool) are mocked. That is sufficient here: the goal is to prove *our* modules
 * pass the intended configuration to Better Auth — the shared pool, `NEXTAUTH_SECRET`, the
 * `/api/auth` base path, and the `nextCookies` plugin — not to exercise Better Auth itself.
 */

const mockHandler = jest.fn();
const mockBetterAuth = jest.fn(() => ({ handler: mockHandler }));
const mockNextCookies = jest.fn(() => ({ id: 'next-cookies' }));
const mockGenericOAuth = jest.fn(() => ({ id: 'generic-oauth' }));
// The OLO-10.10 twoFactor plugin factory — stubbed so the instance loads under ts-jest (better-auth
// is ESM-only). The stub echoes the options back so the test can assert issuer + table mapping.
const mockTwoFactor = jest.fn((options: unknown) => ({ id: 'two-factor', options }));
const mockTwoFactorClient = jest.fn(() => ({ id: 'two-factor-client' }));
// The OLO-10.12 customSession plugin factory — echoes the transform fn back so the test can assert it
// is registered with a function. The `augmentBetterAuthUser` transform itself (and its tenant
// derivation) is covered by `better-auth-session-shape.test.ts`, mocked here so importing auth.ts does
// not pull the tenant-derivation deps (next/headers, membership store).
const mockCustomSession = jest.fn((fn: unknown) => ({ id: 'custom-session', fn }));
const mockCustomSessionClient = jest.fn(() => ({ id: 'custom-session-client' }));
const mockGenericOAuthClient = jest.fn(() => ({ id: 'generic-oauth-client' }));
// The OLO-10.13 one-time-code sign-in plugin — stubbed so importing auth.ts does not pull the endpoint
// deps (better-auth/api, better-auth/cookies, the DB module). Its behaviour is covered by
// `better-auth-one-time-code-actions.test.ts`.
const mockOneTimeCodePlugin = jest.fn(() => ({ id: 'one-time-code' }));
const mockCreateAuthClient = jest.fn(() => ({
  signIn: jest.fn(),
  signOut: jest.fn(),
  useSession: jest.fn(),
  getSession: jest.fn(),
}));

jest.mock('better-auth', () => ({ betterAuth: mockBetterAuth }));
jest.mock('better-auth/next-js', () => ({ nextCookies: mockNextCookies }));
jest.mock('better-auth/react', () => ({ createAuthClient: mockCreateAuthClient }));
jest.mock('better-auth/plugins/two-factor', () => ({ twoFactor: mockTwoFactor }));
jest.mock('better-auth/plugins', () => ({ customSession: mockCustomSession }));
jest.mock('@lib/auth/better-auth-session-shape', () => ({ augmentBetterAuthUser: jest.fn() }));
jest.mock('better-auth/client/plugins', () => ({
  twoFactorClient: mockTwoFactorClient,
  customSessionClient: mockCustomSessionClient,
  genericOAuthClient: mockGenericOAuthClient,
}));
// `better-auth/plugins/generic-oauth` is ESM-only and is registered by auth.ts for the OLO-10.7 OAuth
// providers; stub the plugin factory so the instance loads (the provider construction itself is
// covered by `better-auth-oauth-providers.test.ts`).
jest.mock('better-auth/plugins/generic-oauth', () => ({ genericOAuth: mockGenericOAuth }));
jest.mock('@lib/auth/better-auth-one-time-code', () => ({
  oneTimeCodePlugin: mockOneTimeCodePlugin,
  ONE_TIME_CODE_VERIFY_PATH: '/one-time-code/verify',
}));
// `better-auth/api` is ESM-only (ts-jest's CommonJS transform cannot require it). The credential
// wiring (`better-auth-credentials.ts`, transitively imported by auth.ts) calls createAuthMiddleware
// at module load, so stub it to return the handler unchanged and provide a minimal APIError.
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
  APIError: class APIError extends Error {
    status: string;
    body: unknown;
    constructor(status: string, body?: { message?: string }) {
      super(body?.message);
      this.status = status;
      this.body = body;
    }
  },
}));
// Stub the shared Postgres pool so importing the server instance never opens a real connection.
jest.mock('@lib/db/db', () => ({ query: jest.fn() }));

describe('lib/auth/auth.ts (Better Auth server instance)', () => {
  const originalSecret = process.env.NEXTAUTH_SECRET;
  const originalBetterAuthUrl = process.env.BETTER_AUTH_URL;
  const originalNextAuthUrl = process.env.NEXTAUTH_URL;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCookieDomain = process.env.NEXTAUTH_COOKIE_DOMAIN;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  afterEach(() => {
    restoreEnv('NEXTAUTH_SECRET', originalSecret);
    restoreEnv('BETTER_AUTH_URL', originalBetterAuthUrl);
    restoreEnv('NEXTAUTH_URL', originalNextAuthUrl);
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('NEXTAUTH_COOKIE_DOMAIN', originalCookieDomain);
  });

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it('constructs Better Auth with the shared pool, NEXTAUTH_SECRET and /api/auth base path', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';
    process.env.BETTER_AUTH_URL = 'https://app.example.test';

    const { auth } = await import('@lib/auth/auth');

    expect(mockBetterAuth).toHaveBeenCalledTimes(1);
    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.appName).toBe('apiome');
    expect(config.secret).toBe('test-secret');
    expect(config.baseURL).toBe('https://app.example.test');
    expect(config.basePath).toBe('/api/auth');
    expect(config.database).toBeDefined();
    // Five plugins: the OLO-10.7 genericOAuth (the four OAuth providers), the OLO-10.10 twoFactor
    // plugin, the OLO-10.13 one-time-code sign-in plugin, the OLO-10.12 customSession (session shaping),
    // then nextCookies — which must stay LAST so Better Auth can set cookies from Next.js server actions.
    expect(mockGenericOAuth).toHaveBeenCalledTimes(1);
    expect(mockTwoFactor).toHaveBeenCalledTimes(1);
    expect(mockOneTimeCodePlugin).toHaveBeenCalledTimes(1);
    expect(mockCustomSession).toHaveBeenCalledTimes(1);
    expect(mockNextCookies).toHaveBeenCalledTimes(1);
    expect(config.plugins).toHaveLength(5);
    expect(config.plugins[config.plugins.length - 1]).toEqual({ id: 'next-cookies' });
    // The four OAuth providers are trusted for Better Auth's own account-linking, reached only after
    // the resolution engine has already admitted a verified sign-in (OLO-10.7).
    expect(config.account.accountLinking.enabled).toBe(true);
    expect([...config.account.accountLinking.trustedProviders].sort()).toEqual([
      'azure',
      'github',
      'gitlab',
      'google',
      'okta',
    ]);
    expect(auth).toBeDefined();
  });

  it('passes the OLO-10.3 session strategy, cookie parity and trusted origins', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';
    process.env.NEXTAUTH_COOKIE_DOMAIN = '.apiome.dev';

    await import('@lib/auth/auth');

    const config = mockBetterAuth.mock.calls[0][0];
    // 30-day DB session with 24h refresh + a short signed cookie cache (design §1).
    expect(config.session).toEqual({
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 60 },
    });
    // Cross-subdomain cookie scoping on the shared parent domain, matching the legacy engine.
    expect(config.advanced).toEqual({
      crossSubDomainCookies: { enabled: true, domain: '.apiome.dev' },
    });
    expect(config.trustedOrigins).toContain('https://*.apiome.dev');
  });

  it('keeps apiome.users as the user model via field mapping (design §2.1)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.user).toEqual({
      modelName: 'users',
      fields: {
        emailVerified: 'verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    });
  });

  it('enables credential sign-in with bcrypt hashing/verification (OLO-10.5)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    const config = mockBetterAuth.mock.calls[0][0];
    expect(config.emailAndPassword.enabled).toBe(true);
    // Self-service sign-up stays off (new users flow through apiome's own path), email verification on.
    expect(config.emailAndPassword.disableSignUp).toBe(true);
    expect(config.emailAndPassword.requireEmailVerification).toBe(true);
    // Custom bcrypt hash/verify replaces Better Auth's default scrypt so relocated hashes validate.
    expect(typeof config.emailAndPassword.password.hash).toBe('function');
    expect(typeof config.emailAndPassword.password.verify).toBe('function');
  });

  it('wires the per-account/per-IP credential rate-limit hooks (OLO-10.5)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    const config = mockBetterAuth.mock.calls[0][0];
    expect(typeof config.hooks.before).toBe('function');
    expect(typeof config.hooks.after).toBe('function');
  });

  it('registers the twoFactor plugin with the app name as issuer and the two_factor table (OLO-10.10)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    // Issuer = the app name (the label an authenticator app shows), table mapped to snake_case
    // `two_factor` (the plugin keeps its native camelCase field names — design §2.5).
    expect(mockTwoFactor).toHaveBeenCalledTimes(1);
    expect(mockTwoFactor).toHaveBeenCalledWith({ issuer: 'apiome', twoFactorTable: 'two_factor' });

    // The twoFactor plugin sits AFTER genericOAuth and BEFORE nextCookies (which must stay last).
    const config = mockBetterAuth.mock.calls[0][0];
    const twoFactorIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'two-factor',
    );
    const nextCookiesIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'next-cookies',
    );
    expect(twoFactorIndex).toBeGreaterThanOrEqual(0);
    expect(twoFactorIndex).toBeLessThan(nextCookiesIndex);
  });

  it('registers the one-time-code sign-in plugin before nextCookies (OLO-10.13)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    // The plugin's session-establishing endpoint must run before nextCookies so the session cookie it
    // sets is forwarded from the Next.js server action that redeems the one-time code.
    expect(mockOneTimeCodePlugin).toHaveBeenCalledTimes(1);
    const config = mockBetterAuth.mock.calls[0][0];
    const oneTimeCodeIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'one-time-code',
    );
    const nextCookiesIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'next-cookies',
    );
    expect(oneTimeCodeIndex).toBeGreaterThanOrEqual(0);
    expect(oneTimeCodeIndex).toBeLessThan(nextCookiesIndex);
  });

  it('registers the customSession plugin with a transform function, before nextCookies (OLO-10.12)', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await import('@lib/auth/auth');

    // customSession shapes every session read into the app contract (user_id + current_tenant_id).
    expect(mockCustomSession).toHaveBeenCalledTimes(1);
    expect(typeof mockCustomSession.mock.calls[0][0]).toBe('function');

    // It sits AFTER twoFactor and BEFORE nextCookies (which must stay last).
    const config = mockBetterAuth.mock.calls[0][0];
    const customSessionIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'custom-session',
    );
    const twoFactorIndex = config.plugins.findIndex((p: { id?: string }) => p?.id === 'two-factor');
    const nextCookiesIndex = config.plugins.findIndex(
      (p: { id?: string }) => p?.id === 'next-cookies',
    );
    expect(customSessionIndex).toBeGreaterThan(twoFactorIndex);
    expect(customSessionIndex).toBeLessThan(nextCookiesIndex);
  });

  it('falls back to NEXTAUTH_URL for the base URL when BETTER_AUTH_URL is unset', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret';
    delete process.env.BETTER_AUTH_URL;
    process.env.NEXTAUTH_URL = 'https://legacy.example.test';

    await import('@lib/auth/auth');

    expect(mockBetterAuth.mock.calls[0][0].baseURL).toBe('https://legacy.example.test');
  });

  it('betterAuthHandler delegates the request to auth.handler', async () => {
    mockHandler.mockResolvedValue('handled');
    const { betterAuthHandler } = await import('@lib/auth/auth');
    const request = { url: 'https://app.example.test/api/auth/get-session' } as unknown as Request;

    const result = await betterAuthHandler(request);

    expect(mockHandler).toHaveBeenCalledWith(request);
    expect(result).toBe('handled');
  });
});

describe('lib/auth/auth-client.ts (Better Auth browser client)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('creates the client on the /api/auth base path with the twoFactor, customSession & genericOAuth client plugins', async () => {
    const { authClient } = await import('@lib/auth/auth-client');

    // Base path unchanged; the client mirrors the server plugins: twoFactorClient (OLO-10.10),
    // customSessionClient (OLO-10.12, so useSession() typing carries user_id/current_tenant_id), and
    // genericOAuthClient (OLO-10.12, exposes authClient.signIn.oauth2 for the OAuth sign-in swap).
    expect(mockCreateAuthClient).toHaveBeenCalledWith({
      basePath: '/api/auth',
      plugins: [
        { id: 'two-factor-client' },
        { id: 'custom-session-client' },
        { id: 'generic-oauth-client' },
      ],
    });
    expect(mockTwoFactorClient).toHaveBeenCalledTimes(1);
    expect(mockCustomSessionClient).toHaveBeenCalledTimes(1);
    expect(mockGenericOAuthClient).toHaveBeenCalledTimes(1);
    expect(authClient).toBeDefined();
    expect(authClient.signIn).toBeDefined();
  });
});
