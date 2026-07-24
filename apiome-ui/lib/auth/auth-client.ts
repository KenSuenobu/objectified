import { createAuthClient } from 'better-auth/react';
import {
  twoFactorClient,
  customSessionClient,
  genericOAuthClient,
} from 'better-auth/client/plugins';
// Type-only import: erased at compile time, so the server instance (and its Postgres pool) is never
// bundled into the browser client. It exists purely so `customSessionClient` can infer the extra
// session fields (`user_id`/`current_tenant_id`) the server `customSession` plugin injects (OLO-10.12).
import type { BetterAuthInstance } from './auth';
import {
  peekTwoFactorCallbackUrl,
  twoFactorLoginPath,
} from './two-factor-callback';
import { browserNavigate } from './browser-navigate';

/**
 * Better Auth browser client (OLO-10.2, extended for 2FA in OLO-10.10 / OLO-9.13 #5014).
 *
 * The React client the UI calls as `authClient.signIn` / `authClient.signOut` /
 * `authClient.useSession` (and `authClient.twoFactor.*` for TOTP).
 *
 * `basePath` stays at the default `/api/auth`, which the app already serves same-origin, so the
 * client needs no explicit `baseURL` in the browser — it resolves against the current origin.
 *
 * `twoFactorClient({ onTwoFactorRedirect })` (OLO-9.13 #5014) sends password sign-ins that return
 * `twoFactorRedirect` to `/login/2fa`, preserving the intended post-login callback. OAuth/SSO
 * second-factor is out of scope — Better Auth's stock after-hook only matches credential paths.
 *
 * `customSessionClient()` mirrors the server `customSession` plugin so `authClient.useSession()` typing
 * carries the injected `user_id`/`current_tenant_id` (OLO-10.12).
 *
 * `genericOAuthClient()` is the browser counterpart of the server `genericOAuth` plugin (OLO-10.7): it
 * exposes `authClient.signIn.oauth2({ providerId, callbackURL })`, the client entry point the OAuth
 * sign-in / account-link buttons call after the swap (OLO-10.12).
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window === 'undefined') return;
        // Peek (do not clear) — the 2fa page take()s after a successful verify.
        browserNavigate(twoFactorLoginPath(peekTwoFactorCallbackUrl()));
      },
    }),
    customSessionClient<BetterAuthInstance>(),
    genericOAuthClient(),
  ],
});
