/**
 * LINE provider trust-gate smoke tests (OLO-9.41, #5054).
 *
 * Pins the slug on the linkable / auto-link sets so a regression that drops LINE from either
 * gate fails loudly. Endpoint + email-permission behaviour live in
 * `better-auth-oauth-providers.test.ts`.
 */

import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('LINE provider trust gates (OLO-9.41)', () => {
  test('line is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('line')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('line')).toBe(true);
  });
});
