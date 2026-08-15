/**
 * Next.js server-startup hook (OLO-7.2, #4224; OLO-9.6 discovery probe; OLO-8.8 DB-aware config).
 *
 * `register()` runs once when the server boots (dev and production alike), before any
 * request is served. It validates the sign-in provider config so a partially-configured
 * provider (e.g. a client id without its secret) fails loud at startup with an actionable
 * message instead of degrading silently at first login. When the generic OIDC provider is fully
 * configured, it also probes `<OIDC_ISSUER>/.well-known/openid-configuration` so a bad issuer
 * fails at boot rather than leaving a broken login page (OLO-9.6). `AUTH_PROVIDER_VALIDATION=warn`
 * downgrades either failure to a logged warning.
 *
 * Both checks run against the **merged** DB-over-env config (OLO-8.5), not raw `process.env`:
 * provider config stored from the admin screen takes precedence over `.env`, so a provider whose
 * credentials live only in the database must not be reported as "missing env" (OLO-8.8). Resolving
 * here also warms the resolver's TTL cache, so the first login does not pay for the fetch. The
 * resolver never throws — it degrades to env and reports that as the `unavailable` origin, which
 * `validateProviderEnv` treats as inconclusive rather than as grounds to refuse startup.
 *
 * See `lib/auth/provider-registry.ts` (`validateProviderEnv`, `validateOidcDiscoveryEnv`),
 * `lib/auth/provider-config-resolver.ts` (`resolveProviderEnvWithSource`), and
 * `docs/AUTH_PROVIDER_SETUP.md`.
 */
export async function register(): Promise<void> {
  // Only the Node.js server reads provider secrets; skip the edge runtime so each issue is
  // reported once and the auth modules stay out of the edge bundle.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const [registry, resolver] = await Promise.all([
    import('../lib/auth/provider-registry'),
    import('../lib/auth/provider-config-resolver'),
  ]);
  const { PROVIDER_REGISTRY, validateProviderEnv, validateOidcDiscoveryEnv } = registry;
  const { resolveProviderEnvWithSource } = resolver;
  const { env, source } = await resolveProviderEnvWithSource();
  validateProviderEnv(env, PROVIDER_REGISTRY, source);
  await validateOidcDiscoveryEnv(env);
}
