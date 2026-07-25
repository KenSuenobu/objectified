/**
 * VK provider trust-gate smoke tests (OLO-9.42, #5055).
 *
 * Pins the slug on the linkable / auto-link sets so a regression that drops VK from either
 * gate fails loudly. Endpoint + fail-closed email behaviour live in
 * `better-auth-oauth-providers.test.ts`.
 */

import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('VK provider trust gates (OLO-9.42)', () => {
  test('vk is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('vk')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('vk')).toBe(true);
  });
});
