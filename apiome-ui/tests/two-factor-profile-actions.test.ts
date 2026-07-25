/**
 * Unit tests for OLO-9.15 profile 2FA server actions (`two-factor-profile-actions.ts`).
 */

const mockCookieGet = jest.fn();
const mockCookieSet = jest.fn();
const mockCookies = jest.fn(async () => ({ get: mockCookieGet, set: mockCookieSet }));
const mockHeaders = jest.fn(async () => new Headers({ 'x-test': '1' }));
const mockGetAuthSession = jest.fn();
const mockViewBackupCodes = jest.fn();
const mockDeleteVerificationByIdentifier = jest.fn();
const mockMakeSignature = jest.fn();
const mockConstantTimeEqual = jest.fn();
const mockResolveBetterAuthSecret = jest.fn(() => 'test-secret');
const mockGetSharedCookieDomain = jest.fn(() => undefined as string | undefined);

jest.mock('next/headers', () => ({
  cookies: (...args: unknown[]) => mockCookies(...args),
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

jest.mock('@lib/auth/server-session', () => ({
  getAuthSession: (...args: unknown[]) => mockGetAuthSession(...args),
}));

jest.mock('@lib/auth/auth', () => ({
  auth: {
    api: { viewBackupCodes: (...args: unknown[]) => mockViewBackupCodes(...args) },
    $context: Promise.resolve({
      internalAdapter: {
        deleteVerificationByIdentifier: (...args: unknown[]) =>
          mockDeleteVerificationByIdentifier(...args),
      },
    }),
  },
}));

jest.mock('@lib/auth/better-auth-session', () => ({
  resolveBetterAuthSecret: (...args: unknown[]) => mockResolveBetterAuthSecret(...args),
}));

jest.mock('@lib/auth/cookie-options', () => ({
  getSharedCookieDomain: (...args: unknown[]) => mockGetSharedCookieDomain(...args),
}));

jest.mock('better-auth/crypto', () => ({
  makeSignature: (...args: unknown[]) => mockMakeSignature(...args),
  constantTimeEqual: (...args: unknown[]) => mockConstantTimeEqual(...args),
}));

import {
  getBackupCodeStatus,
  getTrustedDeviceStatus,
  revokeThisTrustedDevice,
} from '@lib/auth/two-factor-profile-actions';
import {
  TRUST_DEVICE_COOKIE_BASE,
  TRUST_DEVICE_COOKIE_NAMES,
} from '@lib/auth/two-factor-trust-cookie';

describe('two-factor-profile-actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSharedCookieDomain.mockReturnValue(undefined);
    mockResolveBetterAuthSecret.mockReturnValue('test-secret');
    mockCookieGet.mockReturnValue(undefined);
  });

  describe('getBackupCodeStatus', () => {
    it('returns null when unauthenticated or 2FA is off', async () => {
      mockGetAuthSession.mockResolvedValue(null);
      expect(await getBackupCodeStatus()).toEqual({ remaining: null });

      mockGetAuthSession.mockResolvedValue({
        user: { user_id: 'u1', twoFactorEnabled: false },
      });
      expect(await getBackupCodeStatus()).toEqual({ remaining: null });
      expect(mockViewBackupCodes).not.toHaveBeenCalled();
    });

    it('returns the remaining unused backup code count', async () => {
      mockGetAuthSession.mockResolvedValue({
        user: { user_id: 'u1', twoFactorEnabled: true },
      });
      mockViewBackupCodes.mockResolvedValue({
        backupCodes: ['a', 'b', 'c'],
      });

      expect(await getBackupCodeStatus()).toEqual({ remaining: 3 });
      expect(mockViewBackupCodes).toHaveBeenCalledWith(
        expect.objectContaining({ body: { userId: 'u1' } })
      );
    });

    it('returns null when viewBackupCodes fails', async () => {
      mockGetAuthSession.mockResolvedValue({
        user: { user_id: 'u1', twoFactorEnabled: true },
      });
      mockViewBackupCodes.mockRejectedValue(new Error('boom'));

      expect(await getBackupCodeStatus()).toEqual({ remaining: null });
    });
  });

  describe('getTrustedDeviceStatus', () => {
    it('is false when no trust cookie is present', async () => {
      expect(await getTrustedDeviceStatus()).toEqual({ trusted: false });
    });

    it('is true when a trust cookie name is set', async () => {
      mockCookieGet.mockImplementation((name: string) =>
        name === TRUST_DEVICE_COOKIE_BASE ? { value: 'token!trust-device-abc.sig====' } : undefined
      );
      expect(await getTrustedDeviceStatus()).toEqual({ trusted: true });
    });
  });

  describe('revokeThisTrustedDevice', () => {
    it('fails closed when unauthenticated', async () => {
      mockGetAuthSession.mockResolvedValue(null);
      expect(await revokeThisTrustedDevice()).toEqual({ ok: false });
      expect(mockCookieSet).not.toHaveBeenCalled();
    });

    it('expires trust cookie variants and deletes the verification when signed cookie verifies', async () => {
      mockGetAuthSession.mockResolvedValue({
        user: { user_id: 'u1', twoFactorEnabled: true },
      });
      mockCookieGet.mockImplementation((name: string) =>
        name === `__Secure-${TRUST_DEVICE_COOKIE_BASE}`
          ? { value: 'hmacToken!trust-device-xyz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
          : undefined
      );
      mockMakeSignature.mockResolvedValue(
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      );
      mockConstantTimeEqual.mockReturnValue(true);

      expect(await revokeThisTrustedDevice()).toEqual({ ok: true });
      expect(mockDeleteVerificationByIdentifier).toHaveBeenCalledWith('trust-device-xyz');

      for (const name of TRUST_DEVICE_COOKIE_NAMES) {
        expect(mockCookieSet).toHaveBeenCalledWith(
          name,
          '',
          expect.objectContaining({ path: '/', maxAge: 0, httpOnly: true })
        );
      }
    });

    it('also domain-scopes cookie expiry when a shared domain is configured', async () => {
      mockGetAuthSession.mockResolvedValue({
        user: { user_id: 'u1', twoFactorEnabled: true },
      });
      mockGetSharedCookieDomain.mockReturnValue('.apiome.dev');

      expect(await revokeThisTrustedDevice()).toEqual({ ok: true });

      expect(mockCookieSet).toHaveBeenCalledWith(
        TRUST_DEVICE_COOKIE_BASE,
        '',
        expect.objectContaining({ domain: '.apiome.dev', maxAge: 0 })
      );
    });
  });

  describe('getEmailOtpAvailability', () => {
    const originalKey = process.env.SENDGRID_API_KEY;
    const originalFrom = process.env.EMAIL_FROM;

    afterEach(() => {
      if (originalKey === undefined) delete process.env.SENDGRID_API_KEY;
      else process.env.SENDGRID_API_KEY = originalKey;
      if (originalFrom === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = originalFrom;
    });

    it('reports available when SendGrid env is set', async () => {
      process.env.SENDGRID_API_KEY = 'sg-key';
      process.env.EMAIL_FROM = 'noreply@example.com';
      const { getEmailOtpAvailability } = await import('@lib/auth/two-factor-profile-actions');
      expect(await getEmailOtpAvailability()).toEqual({ available: true });
    });

    it('reports unavailable when SendGrid env is missing', async () => {
      delete process.env.SENDGRID_API_KEY;
      delete process.env.EMAIL_FROM;
      jest.resetModules();
      const { getEmailOtpAvailability } = await import('@lib/auth/two-factor-profile-actions');
      expect(await getEmailOtpAvailability()).toEqual({ available: false });
    });
  });
});
