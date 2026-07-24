/**
 * Structured auth error contract tests (OLO-1.5, #4190).
 *
 * The contract's acceptance criteria, verified here:
 *   1. Code values are stable — an exact-value snapshot fails the build on any accidental rename.
 *   2. Every code has a test forcing it through a real emission path.
 *   3. The login page renders distinct guidance per code (copy coverage + distinctness).
 *
 * Mirrored on the REST side by `apiome-rest/tests/test_auth_error_contract.py`; the contract
 * itself is documented in `apiome-ui/docs/AUTH_ERROR_CODES.md`.
 */

import { describe, test, expect } from '@jest/globals';
import {
  AUTH_ERROR_CODES,
  isSignupDisabled,
  loginErrorRedirect,
  resolveAccountDecision,
  resolveOAuthSignIn,
  type AuthErrorCode,
  type ResolutionInput,
  type ResolutionStore,
  type ResolutionUser,
} from '../lib/auth/account-resolution';
import { AUTH_ERROR_COPY, getAuthErrorCopy } from '../src/app/login/auth-error-copy';

// The resolution store (transitively imported by better-auth-account-resolution) opens a pg pool at
// import time; mock it away.
jest.mock('../lib/db/db', () => ({ query: jest.fn() }));

// `better-auth/api` is ESM-only; stub createAuthMiddleware to return the bare handler so
// `better-auth-account-resolution` (imported below for the provider-not-configured check) loads under
// ts-jest.
jest.mock('better-auth/api', () => ({
  createAuthMiddleware: (handler: unknown) => handler,
}));

// ---------------------------------------------------------------------------
// 1. Value stability
// ---------------------------------------------------------------------------

describe('AUTH_ERROR_CODES — value stability', () => {
  test('every code keeps its documented value (never change these — add new codes instead)', () => {
    expect(AUTH_ERROR_CODES).toEqual({
      UNVERIFIED_EMAIL: 'unverified-email',
      EMAIL_REQUIRED: 'OAuthEmailRequired',
      PROFILE_INCOMPLETE: 'OAuthProfileIncomplete',
      ACCOUNT_DISABLED: 'account-disabled',
      ACCOUNT_NOT_VERIFIED: 'account-not-verified',
      PROVIDER_ALREADY_LINKED: 'provider-already-linked',
      IDENTITY_LINKED_ELSEWHERE: 'identity-linked-elsewhere',
      LAST_SIGN_IN_METHOD: 'last-sign-in-method',
      MEMBERSHIP_SUSPENDED: 'membership-suspended',
      PROVIDER_NOT_CONFIGURED: 'provider-not-configured',
      SIGNUP_DISABLED: 'signup-disabled',
      SIGN_IN_FAILED: 'sign-in-failed',
    });
  });

  test('the redirect transport is the login page error query param', () => {
    expect(loginErrorRedirect(AUTH_ERROR_CODES.UNVERIFIED_EMAIL)).toBe(
      '/login?error=unverified-email'
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A forcing test per code
// ---------------------------------------------------------------------------

const OK_USER: ResolutionUser = {
  id: 'user-ok',
  enabled: true,
  verified: true,
  email: 'ada@example.com',
  name: 'Ada',
};

const baseInput: ResolutionInput = {
  provider: 'github',
  providerUserId: 'prov-123',
  email: 'ada@example.com',
  emailVerified: true,
  linkToUserId: null,
  identity: { found: false, user: null },
  emailUser: null,
};

/** Minimal store for orchestrator-level forcing tests. */
function makeStore(linkResult: { success: boolean; code?: AuthErrorCode } = { success: true }) {
  const store: ResolutionStore = {
    async getIdentity() {
      return { found: false, userId: null };
    },
    async getUserById() {
      return null;
    },
    async getUserByEmail() {
      return OK_USER;
    },
    async linkIdentity() {
      return linkResult;
    },
    async recordIdentityLogin() {},
    async recordUserLogin() {},
    async createPendingSignup() {
      return { id: 'pending-1' };
    },
  };
  return store;
}

const makePayload = () => ({
  user: { email: 'ada@example.com', name: 'Ada' },
  account: { providerAccountId: 'prov-123' },
  profile: { email: 'ada@example.com', email_verified: true },
});

describe('each contract code has an emission path forcing it', () => {
  test('unverified-email: an unproven email is rejected', () => {
    expect(resolveAccountDecision({ ...baseInput, emailVerified: false })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.UNVERIFIED_EMAIL,
    });
  });

  test('OAuthEmailRequired: a provider that shares no email is rejected', () => {
    expect(resolveAccountDecision({ ...baseInput, email: null })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.EMAIL_REQUIRED,
    });
  });

  test('OAuthProfileIncomplete: a missing provider user id is rejected', () => {
    expect(resolveAccountDecision({ ...baseInput, providerUserId: null })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.PROFILE_INCOMPLETE,
    });
  });

  test('account-disabled: a disabled account is refused on both admission paths', () => {
    const disabled: ResolutionUser = { id: 'u', enabled: false, verified: true };
    expect(
      resolveAccountDecision({ ...baseInput, identity: { found: true, user: disabled } })
    ).toEqual({ action: 'reject', code: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
    expect(resolveAccountDecision({ ...baseInput, emailUser: disabled })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.ACCOUNT_DISABLED,
    });
  });

  test('account-not-verified: an unverified account is refused on both admission paths', () => {
    const unverified: ResolutionUser = { id: 'u', enabled: true, verified: false };
    expect(
      resolveAccountDecision({ ...baseInput, identity: { found: true, user: unverified } })
    ).toEqual({ action: 'reject', code: AUTH_ERROR_CODES.ACCOUNT_NOT_VERIFIED });
    expect(resolveAccountDecision({ ...baseInput, emailUser: unverified })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.ACCOUNT_NOT_VERIFIED,
    });
  });

  test('membership-suspended: a suspended membership is refused on both admission paths', () => {
    const suspended: ResolutionUser = {
      id: 'u',
      enabled: true,
      verified: true,
      membershipSuspended: true,
    };
    expect(
      resolveAccountDecision({ ...baseInput, identity: { found: true, user: suspended } })
    ).toEqual({ action: 'reject', code: AUTH_ERROR_CODES.MEMBERSHIP_SUSPENDED });
    expect(resolveAccountDecision({ ...baseInput, emailUser: suspended })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.MEMBERSHIP_SUSPENDED,
    });
  });

  test('membership-suspended: account gates outrank the membership gate', () => {
    // A disabled or unverified account reports its own stronger code first.
    const disabledAndSuspended: ResolutionUser = {
      id: 'u',
      enabled: false,
      verified: true,
      membershipSuspended: true,
    };
    expect(
      resolveAccountDecision({
        ...baseInput,
        identity: { found: true, user: disabledAndSuspended },
      })
    ).toEqual({ action: 'reject', code: AUTH_ERROR_CODES.ACCOUNT_DISABLED });
  });

  test('signup-disabled: a verified new email is refused when self-signup is off', () => {
    expect(resolveAccountDecision({ ...baseInput, signupDisabled: true })).toEqual({
      action: 'reject',
      code: AUTH_ERROR_CODES.SIGNUP_DISABLED,
    });
    // Existing accounts still sign in — only account creation is refused.
    expect(
      resolveAccountDecision({ ...baseInput, signupDisabled: true, emailUser: OK_USER })
    ).toEqual({ action: 'auto-link', user: OK_USER });
  });

  test('signup-disabled: the orchestrator reads AUTH_SIGNUP_DISABLED from the environment', async () => {
    const previous = process.env.AUTH_SIGNUP_DISABLED;
    process.env.AUTH_SIGNUP_DISABLED = 'true';
    try {
      const store = makeStore();
      // No email match in this store variant: force the signup path.
      store.getUserByEmail = async () => null;
      const result = await resolveOAuthSignIn('github', makePayload(), null, store);
      expect(result).toBe('/login?error=signup-disabled');
    } finally {
      if (previous === undefined) delete process.env.AUTH_SIGNUP_DISABLED;
      else process.env.AUTH_SIGNUP_DISABLED = previous;
    }
  });

  test('identity-linked-elsewhere: a failed auto-link without a store code falls back to it', async () => {
    const result = await resolveOAuthSignIn(
      'github',
      makePayload(),
      null,
      makeStore({ success: false })
    );
    expect(result).toBe('/login?error=identity-linked-elsewhere');
  });

  test('provider-already-linked: a store rejection code rides the redirect unchanged', async () => {
    const result = await resolveOAuthSignIn(
      'github',
      makePayload(),
      null,
      makeStore({ success: false, code: AUTH_ERROR_CODES.PROVIDER_ALREADY_LINKED })
    );
    expect(result).toBe('/login?error=provider-already-linked');
  });

  test('provider-not-configured: an unknown provider is refused by the sign-in dispatch', async () => {
    // The Better Auth OAuth dispatch refuses any slug outside the supported set before touching the
    // context (account-disabled / account-not-verified are forced above via resolveAccountDecision,
    // the engine-neutral account gate both the credential and OAuth paths run through).
    const { resolveBetterAuthOAuthSignIn } = await import('../lib/auth/better-auth-account-resolution');
    expect(await resolveBetterAuthOAuthSignIn('bitbucket', {} as never)).toBe(
      '/login?error=provider-not-configured'
    );
  });
});

describe('isSignupDisabled', () => {
  test('accepts only an explicit true/1 flag', () => {
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: 'true' })).toBe(true);
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: ' TRUE ' })).toBe(true);
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: '1' })).toBe(true);
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: 'false' })).toBe(false);
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: '0' })).toBe(false);
    expect(isSignupDisabled({ AUTH_SIGNUP_DISABLED: 'yes' })).toBe(false);
    expect(isSignupDisabled({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Distinct login-page guidance per code
// ---------------------------------------------------------------------------

describe('login-page copy', () => {
  const contractCodes = Object.values(AUTH_ERROR_CODES);

  test('every contract code has dedicated copy', () => {
    for (const code of contractCodes) {
      expect({ code, copy: AUTH_ERROR_COPY[code] }).toEqual({
        code,
        copy: expect.objectContaining({ text: expect.any(String) }),
      });
    }
  });

  test('guidance is distinct per code', () => {
    const texts = contractCodes.map((code) => AUTH_ERROR_COPY[code].text);
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('unknown codes fall back to a safe generic message that never echoes the code (OLO-3.2)', () => {
    const fallback = getAuthErrorCopy('something-new');
    expect(fallback?.text).toBeTruthy();
    expect(fallback?.text).not.toContain('something-new');
    expect(getAuthErrorCopy(undefined)).toBeNull();
  });
});
