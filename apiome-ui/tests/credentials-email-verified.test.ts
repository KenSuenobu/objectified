/**
 * Unit tests for the OAuth verified-email resolver (OLO-1.2, #4187).
 *
 * `resolveOAuthEmailVerified` decides whether the provider proved the sign-in email is verified.
 * It must default to *unverified* whenever no explicit verified signal is present — auto-linking on
 * an unverified address is the account-takeover vector the OAuth epic forbids.
 */

import { describe, test, expect } from '@jest/globals';

// The resolution store (transitively imported by account-resolution) opens a pg pool at import time;
// mock it away.
jest.mock('../lib/db/db', () => ({ query: jest.fn() }));

describe('resolveOAuthEmailVerified', () => {
  test('honours a boolean true email_verified claim (OIDC providers)', async () => {
    const { resolveOAuthEmailVerified } = await import('../lib/auth/account-resolution');
    expect(resolveOAuthEmailVerified({ email_verified: true }, {})).toBe(true);
  });

  test('honours a string "true" email_verified claim', async () => {
    const { resolveOAuthEmailVerified } = await import('../lib/auth/account-resolution');
    expect(resolveOAuthEmailVerified({ email_verified: 'true' }, {})).toBe(true);
    expect(resolveOAuthEmailVerified({ email_verified: 'TRUE' }, {})).toBe(true);
  });

  test('falls back to the account object when the profile lacks the claim', async () => {
    const { resolveOAuthEmailVerified } = await import('../lib/auth/account-resolution');
    expect(resolveOAuthEmailVerified({}, { email_verified: true })).toBe(true);
  });

  test('defaults to false when no verified signal is present (GitHub/GitLab default scopes)', async () => {
    const { resolveOAuthEmailVerified } = await import('../lib/auth/account-resolution');
    expect(resolveOAuthEmailVerified({ email: 'a@b.com' }, {})).toBe(false);
    expect(resolveOAuthEmailVerified({ email_verified: false }, {})).toBe(false);
    expect(resolveOAuthEmailVerified({ email_verified: 'no' }, {})).toBe(false);
    expect(resolveOAuthEmailVerified(null, null)).toBe(false);
  });
});
