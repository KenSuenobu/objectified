/**
 * Unit tests for the 2FA second-step helpers and session mapper (OLO-9.13 #5014 + OLO-9.50 #5070).
 */

import {
  TWO_FACTOR_CALLBACK_STORAGE_KEY,
  TWO_FACTOR_METHODS_STORAGE_KEY,
  storeTwoFactorCallbackUrl,
  peekTwoFactorCallbackUrl,
  takeTwoFactorCallbackUrl,
  storeTwoFactorMethods,
  peekTwoFactorMethods,
  takeTwoFactorMethods,
  normalizeTwoFactorMethods,
  twoFactorLoginPath,
} from '@lib/auth/two-factor-callback';
import { mapBetterAuthSession } from '@lib/auth/better-auth-client-compat';

describe('two-factor-callback', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('stores, peeks, and takes the callback URL', () => {
    storeTwoFactorCallbackUrl('/ade/dashboard');
    expect(peekTwoFactorCallbackUrl()).toBe('/ade/dashboard');
    expect(window.sessionStorage.getItem(TWO_FACTOR_CALLBACK_STORAGE_KEY)).toBe('/ade/dashboard');
    expect(takeTwoFactorCallbackUrl()).toBe('/ade/dashboard');
    expect(window.sessionStorage.getItem(TWO_FACTOR_CALLBACK_STORAGE_KEY)).toBeNull();
    expect(takeTwoFactorCallbackUrl('/fallback')).toBe('/fallback');
  });

  it('stores, peeks, and takes twoFactorMethods', () => {
    storeTwoFactorMethods(['totp', 'otp', 'totp', 'sms']);
    expect(peekTwoFactorMethods()).toEqual(['totp', 'otp']);
    expect(JSON.parse(window.sessionStorage.getItem(TWO_FACTOR_METHODS_STORAGE_KEY)!)).toEqual([
      'totp',
      'otp',
    ]);
    expect(takeTwoFactorMethods()).toEqual(['totp', 'otp']);
    expect(window.sessionStorage.getItem(TWO_FACTOR_METHODS_STORAGE_KEY)).toBeNull();
    expect(peekTwoFactorMethods()).toEqual(['totp']);
  });

  it('normalizeTwoFactorMethods defaults empty / unknown to totp', () => {
    expect(normalizeTwoFactorMethods(undefined)).toEqual(['totp']);
    expect(normalizeTwoFactorMethods([])).toEqual(['totp']);
    expect(normalizeTwoFactorMethods(['sms'])).toEqual(['totp']);
    expect(normalizeTwoFactorMethods(['otp'])).toEqual(['otp']);
  });

  it('builds the /login/2fa path with an encoded callbackUrl', () => {
    expect(twoFactorLoginPath()).toBe('/login/2fa');
    expect(twoFactorLoginPath('/ade?x=1')).toBe('/login/2fa?callbackUrl=%2Fade%3Fx%3D1');
  });
});

describe('mapBetterAuthSession (2FA marker)', () => {
  it('exposes twoFactorEnabled and twoFactorElevated when enrolled', () => {
    const session = mapBetterAuthSession({
      user: {
        id: 'u1',
        email: 'a@b.co',
        twoFactorEnabled: true,
        current_tenant_id: 't1',
      },
      session: { expiresAt: '2030-01-02T03:04:05.000Z' },
    });

    expect(session).toEqual({
      user: {
        user_id: 'u1',
        email: 'a@b.co',
        name: null,
        image: null,
        twoFactorEnabled: true,
        current_tenant_id: 't1',
      },
      expires: '2030-01-02T03:04:05.000Z',
      twoFactorElevated: true,
    });
  });

  it('defaults elevation to false when twoFactorEnabled is absent', () => {
    const session = mapBetterAuthSession({
      user: { user_id: 'u1', email: 'a@b.co' },
      session: { expiresAt: new Date('2030-01-02T03:04:05.000Z') },
    });

    expect(session?.user.twoFactorEnabled).toBe(false);
    expect(session?.twoFactorElevated).toBe(false);
  });
});
