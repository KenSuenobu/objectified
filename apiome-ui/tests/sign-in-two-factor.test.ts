/**
 * signInBetterAuth branches for twoFactorRedirect (OLO-9.13 #5014).
 */

const mockSignInEmail = jest.fn();
const mockSignInOauth2 = jest.fn();
const mockSignOut = jest.fn();
const mockUpdateUser = jest.fn();
const mockBrowserNavigate = jest.fn();

jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => mockSignInEmail(...args),
      oauth2: (...args: unknown[]) => mockSignInOauth2(...args),
    },
    signOut: (...args: unknown[]) => mockSignOut(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  },
}));

jest.mock('@lib/auth/browser-navigate', () => ({
  browserNavigate: (...args: unknown[]) => mockBrowserNavigate(...args),
}));

import { signInBetterAuth } from '@lib/auth/better-auth-client-compat';
import { TWO_FACTOR_CALLBACK_STORAGE_KEY } from '@lib/auth/two-factor-callback';

describe('signInBetterAuth twoFactorRedirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('stores the callback and navigates to /login/2fa when twoFactorRedirect is set', async () => {
    mockSignInEmail.mockResolvedValue({
      data: { twoFactorRedirect: true },
      error: null,
    });

    await signInBetterAuth('credentials', {
      callbackUrl: '/ade/dashboard/profile',
      payload: JSON.stringify({ email: 'a@b.co', password: 'secret' }),
    });

    expect(window.sessionStorage.getItem(TWO_FACTOR_CALLBACK_STORAGE_KEY)).toBe(
      '/ade/dashboard/profile'
    );
    expect(mockBrowserNavigate).toHaveBeenCalledWith(
      '/login/2fa?callbackUrl=%2Fade%2Fdashboard%2Fprofile'
    );
  });

  it('navigates to callbackUrl on a full (non-2FA) success', async () => {
    mockSignInEmail.mockResolvedValue({ data: { token: 't' }, error: null });

    await signInBetterAuth('credentials', {
      callbackUrl: '/ade',
      payload: JSON.stringify({ email: 'a@b.co', password: 'secret' }),
    });

    expect(mockBrowserNavigate).toHaveBeenCalledWith('/ade');
  });

  it('navigates to the credentials error page on failure', async () => {
    mockSignInEmail.mockResolvedValue({ data: null, error: { message: 'bad' } });

    await signInBetterAuth('credentials', {
      callbackUrl: '/ade',
      payload: JSON.stringify({ email: 'a@b.co', password: 'wrong' }),
    });

    expect(mockBrowserNavigate).toHaveBeenCalledWith(
      '/login?error=CredentialsSignin&callbackUrl=%2Fade'
    );
  });
});
