/**
 * WeChat provider trust-gate smoke tests (OLO-9.43, #5056).
 *
 * WeChat is link-only (no email): it must stay on LINKABLE_PROVIDERS and off
 * AUTO_LINK_TRUSTED_PROVIDERS. Endpoint + email-required behaviour live in
 * `better-auth-oauth-providers.test.ts`.
 */

import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('WeChat provider trust gates (OLO-9.43)', () => {
  test('wechat is linkable but not auto-link trusted (link-only, no email)', () => {
    expect(LINKABLE_PROVIDERS.has('wechat')).toBe(true);
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('wechat')).toBe(false);
  });
});
