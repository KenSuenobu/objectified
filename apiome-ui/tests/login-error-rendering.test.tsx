/**
 * Login page error & edge-state rendering tests (OLO-3.2, #4200).
 *
 * The acceptance criteria, verified here:
 *   1. Every code of the structured auth error contract (OLO-1.5) renders distinct copy in the
 *      login banner — pinned per code with a DOM snapshot.
 *   2. Unknown codes fall back to a safe generic banner: the page never crashes, and the raw
 *      (attacker-influenced) `?error=` value is never echoed into the page.
 *   3. Retryable codes render a "Try again" affordance that returns to a clean login page with
 *      the callbackUrl preserved; terminal codes (disabled account, suspended membership, …)
 *      offer no retry.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@lib/auth/session-client', () => ({
  signIn: jest.fn(),
}));

jest.mock('../lib/db/helper', () => ({
  createSignupRequest: jest.fn(),
}));

jest.mock('@/app/hooks/useDarkMode', () => ({
  useDarkMode: () => false,
}));

import LoginClient from '../src/app/login/LoginClient';
import { AUTH_ERROR_CODES } from '../lib/auth/account-resolution';
import {
  AUTH_ERROR_COPY,
  GENERIC_AUTH_ERROR,
  getAuthErrorCopy,
} from '../src/app/login/auth-error-copy';
import type { ProviderSummary } from '../lib/auth/provider-registry';

const summary = (id: string, label: string): ProviderSummary => ({
  id,
  label,
  status: 'available',
  enabled: true,
});

const PROVIDERS = [summary('github', 'GitHub'), summary('gitlab', 'GitLab')];

/** Render the login page with an error code and return its banner element. */
function renderBanner(error?: string, callbackUrl?: string) {
  const utils = render(
    <LoginClient ssoProviders={PROVIDERS} error={error} callbackUrl={callbackUrl} />
  );
  return { ...utils, banner: screen.queryByTestId('login-banner') };
}

const retryLink = () => screen.queryByRole('link', { name: /Try again/ });

// ---------------------------------------------------------------------------
// 1. Distinct rendered copy per code (snapshot-tested)
// ---------------------------------------------------------------------------

describe('every known auth error code renders its own banner (OLO-3.2)', () => {
  // All mapped codes: the OLO-1.5 contract plus the NextAuth built-ins the page understands.
  const knownCodes = Object.keys(AUTH_ERROR_COPY);

  test.each(knownCodes)('renders the banner for %s', (code) => {
    const { banner } = renderBanner(code);

    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(AUTH_ERROR_COPY[code].text);
    expect(banner).toMatchSnapshot();
  });

  test('every OLO-1.5 contract code is covered by the map (nothing hits the fallback)', () => {
    for (const code of Object.values(AUTH_ERROR_CODES)) {
      expect({ code, mapped: code in AUTH_ERROR_COPY }).toEqual({ code, mapped: true });
    }
  });

  test('rendered banner content is distinct for every code', () => {
    const rendered = knownCodes.map((code) => {
      const { banner, unmount } = renderBanner(code);
      const text = banner!.textContent;
      unmount();
      return text;
    });
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown codes → safe generic banner, no crash
// ---------------------------------------------------------------------------

describe('unknown error codes (OLO-3.2)', () => {
  test.each([
    'some-code-from-the-future',
    '<script>alert(1)</script>',
    '   ',
  ])('falls back to the safe generic banner for %j without echoing the code', (code) => {
    const { banner } = renderBanner(code);

    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(GENERIC_AUTH_ERROR.text);
    expect(banner!.textContent).not.toContain(code.trim() || code);
    expect(banner).toMatchSnapshot('generic banner');
  });

  test('the generic fallback offers a retry', () => {
    renderBanner('some-code-from-the-future');
    expect(retryLink()).toBeInTheDocument();
  });

  test('no error code renders no banner at all', () => {
    const { banner } = renderBanner(undefined);
    expect(banner).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Retry affordance
// ---------------------------------------------------------------------------

describe('retry affordance (OLO-3.2)', () => {
  const retryable = Object.keys(AUTH_ERROR_COPY).filter((code) => AUTH_ERROR_COPY[code].retry);
  const terminal = Object.keys(AUTH_ERROR_COPY).filter((code) => !AUTH_ERROR_COPY[code].retry);

  test('user-resolvable codes are marked retryable; terminal codes are not', () => {
    expect(retryable.sort()).toEqual(
      [
        AUTH_ERROR_CODES.UNVERIFIED_EMAIL,
        AUTH_ERROR_CODES.ACCOUNT_NOT_VERIFIED,
        AUTH_ERROR_CODES.EMAIL_REQUIRED,
        AUTH_ERROR_CODES.PROFILE_INCOMPLETE,
        AUTH_ERROR_CODES.SIGN_IN_FAILED,
        'SignupSessionExpired',
      ].sort()
    );
    expect(terminal).toContain(AUTH_ERROR_CODES.ACCOUNT_DISABLED);
    expect(terminal).toContain(AUTH_ERROR_CODES.MEMBERSHIP_SUSPENDED);
    expect(terminal).toContain(AUTH_ERROR_CODES.SIGNUP_DISABLED);
    expect(terminal).toContain(AUTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED);
  });

  test.each(retryable)('%s renders a "Try again" link back to a clean login page', (code) => {
    const { unmount } = renderBanner(code);
    expect(retryLink()).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent('/ade')}`);
    unmount();
  });

  test.each(terminal)('%s renders no retry affordance', (code) => {
    const { unmount } = renderBanner(code);
    expect(retryLink()).not.toBeInTheDocument();
    unmount();
  });

  test('the retry link preserves the validated callbackUrl', () => {
    renderBanner(AUTH_ERROR_CODES.UNVERIFIED_EMAIL, '/dashboard/projects');
    expect(retryLink()).toHaveAttribute(
      'href',
      `/login?callbackUrl=${encodeURIComponent('/dashboard/projects')}`
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Resolution helper edge states
// ---------------------------------------------------------------------------

describe('getAuthErrorCopy edge states (OLO-3.2)', () => {
  test('unknown codes resolve to the shared generic copy object', () => {
    expect(getAuthErrorCopy('nope')).toBe(GENERIC_AUTH_ERROR);
  });

  test('the generic copy never contains interpolated content', () => {
    expect(GENERIC_AUTH_ERROR.text).not.toContain('nope');
    expect(getAuthErrorCopy(undefined)).toBeNull();
    expect(getAuthErrorCopy('')).toBeNull();
  });
});
