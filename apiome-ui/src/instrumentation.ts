/**
 * Next.js server-startup hook (OLO-7.2, #4224; OLO-9.6 discovery probe).
 *
 * `register()` runs once when the server boots (dev and production alike), before any
 * request is served. It validates the sign-in provider env config so a partially-configured
 * provider (e.g. a client id without its secret) fails loud at startup with an actionable
 * message instead of degrading silently at first login. When the generic OIDC provider is fully
 * configured, it also probes `<OIDC_ISSUER>/.well-known/openid-configuration` so a bad issuer
 * fails at boot rather than leaving a broken login page (OLO-9.6). `AUTH_PROVIDER_VALIDATION=warn`
 * downgrades either failure to a logged warning.
 *
 * See `lib/auth/provider-registry.ts` (`validateProviderEnv`, `validateOidcDiscoveryEnv`) and
 * `docs/AUTH_PROVIDER_SETUP.md`.
 */
export async function register(): Promise<void> {
  // Only the Node.js server reads provider secrets; skip the edge runtime so each issue is
  // reported once and the auth modules stay out of the edge bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { validateProviderEnv, validateOidcDiscoveryEnv } = await import(
    '../lib/auth/provider-registry'
  );
  validateProviderEnv();
  await validateOidcDiscoveryEnv();
}
