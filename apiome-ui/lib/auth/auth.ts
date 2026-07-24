import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { customSession } from 'better-auth/plugins';
import { augmentBetterAuthUser } from './better-auth-session-shape';
import {
  buildBetterAuthAdvancedOptions,
  buildBetterAuthSessionOptions,
  buildBetterAuthTrustedOrigins,
  resolveBetterAuthSecret,
} from './better-auth-session';
import {
  betterAuthEmailAndPassword,
  credentialRateLimitAfterHandler,
  credentialRateLimitBeforeHandler,
} from './better-auth-credentials';
import { oauthResolutionHandler } from './better-auth-account-resolution';
import { oneTimeCodePlugin } from './better-auth-one-time-code';
import {
  applyOauthRedirectOverride,
  buildGenericOAuthConfigs,
  providerConfigSignature,
  runWithOauthRedirectOverride,
} from './better-auth-oauth-providers';
import { LINKABLE_PROVIDERS } from './account-resolution';
import { resolveProviderEnv, type EnvMap } from './provider-config-resolver';
import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';

// The Better Auth server instance shares the same Postgres pool the rest of apiome-ui uses, so a
// migrated session/account read hits the same database as the REST API. `lib/db/db` is a CommonJS
// module (`module.exports = pool`, no ESM exports), so — like every other lib/db consumer — it is
// pulled in with `require`; an ESM default import fails typecheck ("not a module") for this file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const connectionPool = require('../db/db');

/**
 * The application name Better Auth advertises. Used both as `appName` and as the 2FA `issuer` (the
 * label an authenticator app shows for the account, OLO-10.10 §2.5) — shared here so the two can
 * never drift.
 */
const APP_NAME = 'apiome';

/**
 * Table backing the Better Auth `twoFactor` model (OLO-10.10 #5005).
 *
 * apiome's schema is snake_case, so the plugin's `twoFactor` model is mapped onto `two_factor`
 * (design §2.5). Passed to `twoFactor({ twoFactorTable })`, which sets the model's `modelName`; the
 * plugin's field names stay Better Auth's native quoted camelCase (no field mapping), exactly as the
 * V199 core tables do. MUST match the table created by
 * `apiome-db/scripts/V201__better_auth_two_factor_5005.sql`.
 */
const TWO_FACTOR_TABLE = 'two_factor';

/**
 * Assemble the Better Auth configuration (OLO-10.2, extended through 10.7/10.8) for a given
 * generic-OAuth provider list.
 *
 * Everything except the OAuth provider set — the shared Postgres pool, secret, base path, session /
 * cookie parity, the user-model mapping, credential sign-in, account linking, and the resolution /
 * rate-limit hooks — is identical for every caller; only the `genericOAuth` config varies between the
 * static env build ({@link auth}) and the per-request DB-over-env build ({@link resolveRequestAuthInstance}).
 * Keeping one factory guarantees the two never drift — the Better Auth analogue of the NextAuth
 * `makeAuthOptions` split (OLO-8.6 → 10.8).
 *
 * Config notes:
 * - `secret` reuses `NEXTAUTH_SECRET` so existing tooling and the suite's shared-secret assumption
 *   hold at cutover; a dedicated `BETTER_AUTH_SECRET` (or versioned `BETTER_AUTH_SECRETS`) can take
 *   over without a code change (design §1, {@link resolveBetterAuthSecret}).
 * - `baseURL` uses `BETTER_AUTH_URL` when set, otherwise the existing `NEXTAUTH_URL`.
 * - `basePath` stays at the default `/api/auth`, matching the route the app already serves, so no
 *   client/cookie path churn is needed at cutover.
 * - `session` / `advanced` / `trustedOrigins` implement the OLO-10.3 session strategy & cookie
 *   parity: a 30-day DB session with 24h refresh (matching NextAuth v4 defaults), a short signed
 *   cookie cache, and cross-subdomain cookie scoping + trusted origins on the same shared parent
 *   domain the legacy engine uses — so sessions persist across the app's subdomains exactly as today
 *   (`better-auth-session.ts`, `docs/BETTER_AUTH_MIGRATION.md` §1).
 * - `nextCookies()` must be the last plugin — it lets Better Auth set cookies from Next.js server
 *   actions (its standard App Router integration).
 *
 * @param oauthConfigs The generic-OAuth provider configs to register (from {@link buildGenericOAuthConfigs}).
 * @returns The complete Better Auth options object for this deployment.
 */
function buildBetterAuthConfig(oauthConfigs: GenericOAuthConfig[]) {
  return {
  appName: APP_NAME,
  database: connectionPool,
  secret: resolveBetterAuthSecret(),
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL,
  basePath: '/api/auth',
  trustedOrigins: buildBetterAuthTrustedOrigins(),
  session: buildBetterAuthSessionOptions(),
  advanced: buildBetterAuthAdvancedOptions(),
  // Keep apiome's existing `users` table as Better Auth's `user` model (design §2.1): map the model
  // name (plural table) and the columns that differ from Better Auth's camelCase defaults —
  // `emailVerified → verified` (already boolean, no timestamp conversion) and the snake_case
  // `created_at`/`updated_at`. The reused `users.id` (UUID) is the FK the `session`/`account` tables
  // created by V199 point at. Without this mapping the credential login (below) cannot read the user.
  user: {
    modelName: 'users',
    fields: {
      emailVerified: 'verified',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  },
  // Credential (email/password) sign-in on the relocated `account` password (OLO-10.5): bcrypt
  // hash/verify so the migrated bcrypt hashes validate under Better Auth (which defaults to scrypt),
  // email verification required (mapped onto `users.verified`), self-service sign-up disabled (new
  // accounts still flow through apiome's signup/admin path, which dual-writes the credential account).
  // See `better-auth-credentials.ts` and docs/BETTER_AUTH_MIGRATION.md §2.3.
  emailAndPassword: betterAuthEmailAndPassword,
  // Account linking is reached only *after* the account-resolution engine has admitted the sign-in
  // in each provider's `getUserInfo` (10.7) — the engine rejects every unverified/forged identity
  // and routes brand-new users to onboarding before Better Auth's own handling runs. So on the admit
  // path Better Auth's email-based auto-link to an existing user is safe, and restricting it to the
  // OAuth vocabulary (`LINKABLE_PROVIDERS`: github|gitlab|azure|google) with a required verified
  // email keeps a stray provider from ever linking on its own.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [...LINKABLE_PROVIDERS],
    },
  },
  // The four live OAuth providers, re-expressed on Better Auth's generic OAuth2/OIDC plugin (10.7
  // #5002). Every provider is built from the shared registry (`enabledProviders`), so the enabled set
  // is identical to the NextAuth path and unsetting a provider's env removes its sign-in route. Each
  // provider's `getUserInfo` re-attaches verified-email normalization (OLO-2.5), the Google `hd` gate
  // (OLO-9.2), the azure nOAuth claims (OLO-1.4), and the account-resolution decision (OLO-10.6) —
  // see `better-auth-oauth-providers.ts`. `genericOAuth` mounts the `/oauth2/callback/:id` route the
  // 10.6 resolution adapter already recognises; it must come before `nextCookies()` (which stays
  // last so Better Auth can set cookies from Next.js server actions).
  //
  // 2FA foundation (OLO-10.10 #5005): register the `twoFactor` plugin so the TOTP / backup-code /
  // trusted-device endpoints exist on the migrated stack for OLO-9.13/9.14 to build on — this ticket
  // stands the plugin up only; no enrollment/login UX is added here.
  //   - `issuer: appName` — the label shown in the user's authenticator app (design §2.5).
  //   - `twoFactorTable: TWO_FACTOR_TABLE` — map the plugin's `twoFactor` model onto apiome's
  //     snake_case `two_factor` table (V201). The plugin's own field names stay Better Auth's native
  //     quoted camelCase (`"userId"`/`"secret"`/… — no field mapping, matching the V199 core tables),
  //     so the migration's columns are read out of the box.
  //   - Secret & backup codes are encrypted at rest by the plugin itself, keyed on the Better Auth
  //     secret (`resolveBetterAuthSecret()` above). This is the OLO-10.10 resolution of design R11:
  //     use the plugin's built-in symmetric encryption rather than a bespoke OLO-8.3 envelope, so no
  //     new key-management surface is introduced (docs/BETTER_AUTH_MIGRATION.md §2.5 / R11).
  // Placed before `nextCookies()`, which must stay last (see above).
  // `customSession` (OLO-10.12 #5007) shapes every session read into the app contract the UI and the
  // ~106 API routes consume — `session.user.user_id` (= Better Auth's `user.id`) plus the validated
  // active `current_tenant_id` derived at read time from the durable last-active cookie
  // (`better-auth-session-shape.ts`). Because it transforms the `/get-session` response, both the
  // server reader (`auth.api.getSession()`) and the browser client (`authClient.useSession()`) get
  // the identical shape from this one place, matching what the NextAuth `session`/`jwt` callbacks
  // produced. The callback is fail-safe (tenant derivation swallows its own errors), so it can never
  // break a session read. It runs after `twoFactor` and before `nextCookies()` (which must stay last
  // so Better Auth can set cookies from Next.js server actions).
  //
  // One-time-code sign-in (OLO-10.13 #5008): the OAuth-signup completion signs the new user in with a
  // single-use credential code (`auth_one_time_codes`), which Better Auth has no native endpoint for.
  // `oneTimeCodePlugin()` adds `POST /one-time-code/verify` that consumes the code (the bearer proof)
  // and establishes the session via the internal adapter — closing the parity gap #5007 deferred here.
  // Placed before `nextCookies()` (which must stay last) so the session cookie it sets is forwarded
  // from the Next.js server action that calls it (`better-auth-one-time-code-actions.ts`).
  plugins: [
    genericOAuth({ config: oauthConfigs }),
    twoFactor({ issuer: APP_NAME, twoFactorTable: TWO_FACTOR_TABLE }),
    oneTimeCodePlugin(),
    customSession(async ({ user, session }) => ({
      session,
      user: await augmentBetterAuthUser(user),
    })),
    nextCookies(),
  ],
  // Credential brute-force limiting (OLO-10.5): the `before` handler refuses a locked
  // `/sign-in/email` attempt before any password work; the `after` handler records the outcome. Both
  // are path-gated and no-op for requests they do not own.
  //
  // OAuth account-resolution / nOAuth (OLO-10.6/10.7): the 10.6 `oauthResolutionHandler` reads a
  // `ctx.oauth` payload that would only exist *after* the code exchange, which a `before` hook runs
  // ahead of — so it stays a no-op here. 10.7 finalizes the placement by running the same engine
  // inside each provider's `getUserInfo` (`better-auth-oauth-providers.ts`), the one point in the
  // generic-OAuth callback that has the fetched profile + tokens *before* any user is created. The
  // hook is retained (inert) as defense-in-depth so the resolution gate remains composed on the
  // instance even if a future callback path surfaces `ctx.oauth`.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      await credentialRateLimitBeforeHandler(ctx);
      await oauthResolutionHandler(ctx);
    }),
    after: createAuthMiddleware(async (ctx) => {
      await credentialRateLimitAfterHandler(ctx);
    }),
  },
  };
}

/**
 * Build a Better Auth instance whose OAuth providers come from the given environment.
 *
 * @param providerEnv The env-shaped map to read provider config from (DB-over-env merged env for a
 *   per-request build; `process.env` for the static instance). Defaults to `process.env`.
 * @returns A Better Auth server instance configured for `providerEnv`'s enabled provider set.
 */
export function buildBetterAuthInstance(providerEnv: EnvMap = process.env) {
  return betterAuth(buildBetterAuthConfig(buildGenericOAuthConfigs(providerEnv)));
}

/** A Better Auth server instance, as returned by {@link buildBetterAuthInstance}. */
export type BetterAuthInstance = ReturnType<typeof buildBetterAuthInstance>;

/**
 * Better Auth server instance — the static, env-derived instance (OLO-10.2, extended through 10.7).
 *
 * Imported by server code that only needs to *read* an existing session (which consults the secret,
 * cookies, and DB session/account tables — never the OAuth provider list), so the env build is correct
 * here. Starting a sign-in goes through {@link betterAuthHandler}, which resolves the DB-over-env
 * provider set per request (OLO-10.8). See `docs/BETTER_AUTH_MIGRATION.md`.
 *
 * Since the OLO-10.14 cutover Better Auth is the only engine, so this instance is constructed at module
 * load and backs every session read (`server-session.ts`) and the `/api/auth/[...all]` route.
 */
export const auth = buildBetterAuthInstance(process.env);

/**
 * Per-request Better Auth instance cache (OLO-10.8).
 *
 * Better Auth freezes the `genericOAuth` config when `betterAuth({...})` is evaluated, so — unlike
 * NextAuth v4, which accepts options per call — a DB provider change only lands if the *instance* is
 * rebuilt. Rebuilding on every `/api/auth/*` request (including the frequent get-session) would add
 * plugin-init latency to each call, so instances are cached by a fingerprint of their provider config
 * ({@link providerConfigSignature}): the resolver's DB read is TTL-cached (OLO-8.5) and the config
 * rarely changes, so the fingerprint is stable and the cached instance is reused; an admin edit shifts
 * the fingerprint and the very next sign-in rebuilds against the new config. Seeded with the static
 * env instance so a deployment with no DB overrides reuses {@link auth} and never rebuilds.
 */
let instanceCache: { signature: string; instance: BetterAuthInstance } = {
  signature: providerConfigSignature(buildGenericOAuthConfigs(process.env)),
  instance: auth,
};

/**
 * Resolve the Better Auth instance for a single request from the DB-over-env merged provider config
 * (OLO-10.8, the Better Auth counterpart of the NextAuth per-request rebuild OLO-8.6).
 *
 * Resolves the merged env (OLO-8.5, TTL-cached, never throws), builds the provider config from it, and
 * returns a cached instance when the config is unchanged or a freshly built one when an admin edit
 * shifted it. Degrade-to-env, never a login outage: if resolution or construction fails for any reason,
 * the static env-built {@link auth} instance is returned so sign-in keeps working on `.env` config.
 *
 * @param baseEnv Base environment; defaults to `process.env` (injectable for tests).
 * @param now Current epoch ms; defaults to `Date.now()` (injectable for tests).
 * @returns The Better Auth instance whose provider set reflects the current DB-over-env config.
 */
export async function resolveRequestAuthInstance(
  baseEnv: EnvMap = process.env,
  now: number = Date.now()
): Promise<BetterAuthInstance> {
  try {
    const mergedEnv = await resolveProviderEnv(baseEnv, now);
    const oauthConfigs = buildGenericOAuthConfigs(mergedEnv);
    const signature = providerConfigSignature(oauthConfigs);
    // The check-build-assign-return below is a single synchronous block (no `await`), so concurrent
    // requests cannot interleave within it: each resolves its own instance and updates the shared
    // cache last-writer-wins, which is safe because every built instance is valid for its own config.
    if (signature === instanceCache.signature) {
      return instanceCache.instance;
    }
    const instance = betterAuth(buildBetterAuthConfig(oauthConfigs));
    instanceCache = { signature, instance };
    return instance;
  } catch (error) {
    // Never let provider resolution break sign-in: fall back to the static env instance.
    console.error(
      '[betterAuth] per-request provider resolution failed; using static env instance',
      error instanceof Error ? error.name : 'unknown'
    );
    return auth;
  }
}

/**
 * Better Auth request handler for the `/api/auth/[...all]` catch-all.
 *
 * The instance is resolved per request from the DB-over-env merged config (OLO-10.8), so toggling a
 * provider from the admin settings screen takes effect on the next sign-in without a redeploy.
 * `instance.handler` dispatches on the request method and path internally, so a single function serves
 * every Better Auth endpoint (GET and POST alike). The `/api/auth/[...all]` route delegates to this.
 *
 * The call is wrapped in a per-request redirect-override scope (OLO-10.7): an OAuth provider's
 * `getUserInfo` runs the account-resolution engine and, on any non-admit outcome, publishes the
 * engine's exact redirect path; here we rewrite the Better Auth redirect's `Location` to that path so
 * a rejection lands on the byte-identical `/login?error=<code>` (and onboarding/link) contract
 * (`better-auth-oauth-providers.ts`). For an admitted sign-in no override is set and the response is
 * returned untouched.
 *
 * @param request The incoming request from the Next.js App Router route.
 * @returns The Better Auth response, with an OAuth redirect retargeted when the engine rejected.
 */
export function betterAuthHandler(request: Request): Promise<Response> {
  return runWithOauthRedirectOverride(async () => {
    const instance = await resolveRequestAuthInstance();
    const response = await instance.handler(request);
    return applyOauthRedirectOverride(response);
  });
}
