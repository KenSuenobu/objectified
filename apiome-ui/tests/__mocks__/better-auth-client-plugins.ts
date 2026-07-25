/**
 * Jest stub for `better-auth/client/plugins` (OLO-10.12).
 *
 * Paired with `better-auth-react.ts`: lets tests that transitively import `lib/auth/auth-client.ts`
 * load without the ESM-only `better-auth` package. Each factory returns a small marker object so the
 * client plugin list is still shaped; tests asserting on it (`better-auth-core.test.ts`) provide their
 * own `jest.mock`, which takes precedence.
 */

export const twoFactorClient = (
  _options?: {
    onTwoFactorRedirect?: (ctx?: { twoFactorMethods?: string[] }) => void | Promise<void>;
  }
): { id: string } => ({ id: 'two-factor-client' });
export const customSessionClient = (): { id: string } => ({ id: 'custom-session-client' });
export const genericOAuthClient = (): { id: string } => ({ id: 'generic-oauth-client' });
