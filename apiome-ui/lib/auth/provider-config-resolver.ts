/**
 * DB-over-env merge resolver for sign-in provider config (OLO-8.5, #4971).
 *
 * The whole auth stack reads provider config through `readEnvString(env, key)` with an injectable
 * `env` that has always defaulted to `process.env` (`provider-registry.ts`, OLO-2.3). This module
 * produces the merged `env` to inject instead: an **env-shaped overlay** where, for each provider
 * key (`GITHUB_ID`, `GITHUB_SECRET`, `GITLAB_CLIENT_ID`, `AZURE_AD_*`, provider base-URL/authority
 * extras), the value is the **DB value when set, else `process.env[key]`**. Feeding this to
 * `isProviderEnabled` / `enabledProviders` / the NextAuth provider factories makes DB config take
 * effect with `.env` as the fallback — with zero churn to those consumers (they still just read a
 * `readEnvString` env). OLO-8.6 will resolve this per request so a DB change lands without redeploy.
 *
 * Where the DB values come from: this is a **login-time** path (building providers before anyone is
 * authenticated), so there is no user or admin session to authorize a call. The decrypted config is
 * therefore read from apiome-rest's service-token-gated resolved endpoint (OLO-8.4/8.5,
 * `GET /v1/internal/auth-providers/resolved`) — the one place the KEK lives and decryption happens.
 * A short in-process TTL cache keeps this off the per-login hot path.
 *
 * Degrade-to-env, never break sign-in (OLO-8.6): if the token is unset, the endpoint is unreachable,
 * or it errors, the resolver returns the base env unchanged — login keeps working on `.env` config.
 *
 * Server-only: reads `INTERNAL_SERVICE_TOKEN` (a server secret) and calls apiome-rest. Import from
 * server code only (the NextAuth route / server components), never from a client component.
 */
import { REST_API_BASE_URL } from '../rest-auth';

/** An env-shaped map, matching the `readEnvString` seam's parameter type. */
export type EnvMap = Record<string, string | undefined>;

/** One provider's resolved DB config, as returned by the REST resolved endpoint. */
interface ResolvedProviderConfig {
  /** Explicit enable toggle; `null` ⇒ env-derived enablement. `false` ⇒ operator pinned it off. */
  enabled: boolean | null;
  /** OAuth client id, or `null`/blank to fall back to env. */
  client_id: string | null;
  /** Decrypted OAuth client secret, or `null`/blank to fall back to env. */
  client_secret: string | null;
  /** Non-secret provider extras, keyed by env var name (e.g. `GITLAB_BASE_URL`). */
  config: Record<string, unknown>;
}

/** Shape of the resolved endpoint payload: stored providers only, keyed by id. */
interface ResolvedProviderConfigResponse {
  providers: Record<string, ResolvedProviderConfig>;
}

/**
 * Env var names for each provider's client id / secret. The `config` extras are already env-var-keyed
 * in the DB (e.g. `{ "GITLAB_BASE_URL": "…" }`), so they are overlaid by their own key and need no
 * mapping here. Adding a provider means one entry here (mirroring `PROVIDER_REGISTRY`).
 */
export const PROVIDER_CRED_ENV_KEYS: Record<
  string,
  { clientId: string; clientSecret: string }
> = {
  github: { clientId: 'GITHUB_ID', clientSecret: 'GITHUB_SECRET' },
  gitlab: { clientId: 'GITLAB_CLIENT_ID', clientSecret: 'GITLAB_CLIENT_SECRET' },
  azure: { clientId: 'AZURE_AD_CLIENT_ID', clientSecret: 'AZURE_AD_CLIENT_SECRET' },
  // Google became a live provider after OLO-8.5 (OLO-9.2, #4985) and is in the store vocabulary
  // (V198) + the server registry, so its DB-configured credentials must overlay env like the others.
  google: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  // Okta (OLO-9.3, #4986): issuer lives in config JSONB and overlays via the extras loop below;
  // credentials still need an explicit mapping so DB-over-env enablement works.
  okta: { clientId: 'OKTA_CLIENT_ID', clientSecret: 'OKTA_CLIENT_SECRET' },
  // Cognito / aws (OLO-9.4, #4987): same issuer-in-config pattern as Okta.
  aws: { clientId: 'COGNITO_CLIENT_ID', clientSecret: 'COGNITO_CLIENT_SECRET' },
};

/** Default TTL (ms) for the in-process cache; bounded so a DB change lands within ~a cache window. */
const DEFAULT_CACHE_TTL_MS = 30_000;
/** Hard bounds on the configurable TTL so it can be neither zero (no cache) nor unboundedly stale. */
const MIN_CACHE_TTL_MS = 5_000;
const MAX_CACHE_TTL_MS = 60_000;
/** How long a *failed* fetch is cached, so an outage doesn't hammer REST but recovers quickly. */
const FAILURE_CACHE_TTL_MS = 5_000;
/** Bound on the resolved-endpoint call so a hung REST never stalls a login (degrades to env). */
const FETCH_TIMEOUT_MS = 2_000;

/**
 * Resolve the cache TTL from `AUTH_PROVIDER_CONFIG_CACHE_TTL_MS`, clamped to [MIN, MAX].
 *
 * @param env Environment to read (injectable for tests).
 * @returns The TTL in milliseconds.
 */
function cacheTtlMs(env: EnvMap): number {
  const raw = env.AUTH_PROVIDER_CONFIG_CACHE_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_CACHE_TTL_MS;
  return Math.min(MAX_CACHE_TTL_MS, Math.max(MIN_CACHE_TTL_MS, Math.trunc(parsed)));
}

interface CacheEntry {
  /** The resolved payload, or `null` when the last fetch failed / was skipped. */
  value: ResolvedProviderConfigResponse | null;
  /** Epoch ms after which this entry is stale. */
  expiresAt: number;
}

/** Module-level in-process cache (per server instance). Reset via {@link invalidateProviderConfigCache}. */
let cache: CacheEntry | null = null;

/**
 * Clear the in-process resolved-config cache.
 *
 * The invalidation hook the issue calls for: an OLO-8.4 write in the *same* process can call this so
 * the next resolve re-fetches immediately instead of serving up to one TTL of staleness. (Admin
 * writes land in apiome-rest, a different process, so cross-process freshness still relies on the
 * bounded TTL — accepted by the issue.) Also used by tests to isolate cases.
 */
export function invalidateProviderConfigCache(): void {
  cache = null;
}

/**
 * Whether a candidate override value is present (a non-blank string). Blank ⇒ treated as absent so
 * the env value is kept — "blank DB field ⇒ fallback, not disabled" (issue AC).
 *
 * @param value The candidate value.
 * @returns True when `value` is a string with non-whitespace content.
 */
function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Fetch the resolved provider config from apiome-rest, or `null` on any failure.
 *
 * Returns `null` (never throws) when the service token is unset, the endpoint is unreachable, times
 * out, or responds non-200 — the caller then degrades to env. Never logs the response body (it
 * carries decrypted secrets).
 *
 * @param env Environment to read the service token from (injectable for tests).
 * @returns The parsed payload, or `null` to signal "no DB overlay; use env".
 */
async function fetchResolvedProviderConfig(
  env: EnvMap
): Promise<ResolvedProviderConfigResponse | null> {
  const token = env.INTERNAL_SERVICE_TOKEN?.trim();
  if (!token) {
    // No token ⇒ the resolved read path is disabled; run on env alone. Not an error.
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${REST_API_BASE_URL}/internal/auth-providers/resolved`, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': token,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      // 5xx/4xx (e.g. 503 when REST has no token) ⇒ degrade to env silently. No secret in the body.
      console.warn(
        `[provider-config-resolver] resolved endpoint returned ${response.status}; using env config`
      );
      return null;
    }
    const data = (await response.json()) as ResolvedProviderConfigResponse;
    if (!data || typeof data !== 'object' || typeof data.providers !== 'object') {
      return null;
    }
    return data;
  } catch (error) {
    // Network error / timeout / abort. Degrade to env; message only, never the (secret-bearing) body.
    console.warn(
      `[provider-config-resolver] resolved endpoint fetch failed (${
        error instanceof Error ? error.name : 'unknown'
      }); using env config`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the resolved config through the TTL cache, fetching on miss/expiry.
 *
 * @param env Environment (for the token and TTL).
 * @param now Current epoch ms (injectable for tests).
 * @returns The cached-or-fresh payload, or `null` to signal env-only.
 */
async function getResolvedProviderConfig(
  env: EnvMap,
  now: number
): Promise<ResolvedProviderConfigResponse | null> {
  if (cache && cache.expiresAt > now) {
    return cache.value;
  }
  const value = await fetchResolvedProviderConfig(env);
  // Successful fetches are cached for the full TTL; failures for a short window so an outage neither
  // hammers REST nor lingers once it recovers.
  const ttl = value === null ? FAILURE_CACHE_TTL_MS : cacheTtlMs(env);
  cache = { value, expiresAt: now + ttl };
  return value;
}

/**
 * Overlay the resolved DB config onto a base env, returning the merged env-shaped map.
 *
 * For each stored provider: its client id/secret override the corresponding env keys when present;
 * its `config` extras override their (env-var-named) keys when present; a blank DB value is treated
 * as absent (env kept). A provider explicitly pinned **off** (`enabled === false`) has its cred keys
 * removed from the overlay so `isProviderEnabled` computes `false` even if env still sets them.
 *
 * @param baseEnv The base environment (typically `process.env`).
 * @param resolved The resolved DB payload, or `null` to return `baseEnv` unchanged.
 * @returns A new merged env map; `baseEnv` is never mutated.
 */
export function applyResolvedOverlay(
  baseEnv: EnvMap,
  resolved: ResolvedProviderConfigResponse | null
): EnvMap {
  const overlay: EnvMap = { ...baseEnv };
  if (!resolved) return overlay;

  for (const [providerId, cfg] of Object.entries(resolved.providers)) {
    if (!cfg) continue;
    const keys = PROVIDER_CRED_ENV_KEYS[providerId];

    // Explicit off: strip creds so the provider is disabled regardless of env (V196 `enabled=false`).
    if (cfg.enabled === false && keys) {
      delete overlay[keys.clientId];
      delete overlay[keys.clientSecret];
      continue;
    }

    if (keys) {
      if (isPresent(cfg.client_id)) overlay[keys.clientId] = cfg.client_id;
      if (isPresent(cfg.client_secret)) overlay[keys.clientSecret] = cfg.client_secret;
    }

    // Provider extras are already env-var-keyed; overlay each present value.
    for (const [key, value] of Object.entries(cfg.config ?? {})) {
      if (isPresent(value)) overlay[key] = value;
    }
  }

  return overlay;
}

/**
 * Resolve the merged provider env: DB value where set, else `baseEnv`.
 *
 * This is the injectable `env` the rest of the auth stack should read through — pass its result to
 * `isProviderEnabled`, `enabledProviders`, and the NextAuth provider factories. Never throws:
 * on any failure to reach the DB config it returns `baseEnv` unchanged (degrade to env).
 *
 * @param baseEnv Base environment; defaults to `process.env`.
 * @param now Current epoch ms (injectable for tests; defaults to `Date.now()`).
 * @returns The merged env-shaped overlay.
 */
export async function resolveProviderEnv(
  baseEnv: EnvMap = process.env,
  now: number = Date.now()
): Promise<EnvMap> {
  const resolved = await getResolvedProviderConfig(baseEnv, now);
  return applyResolvedOverlay(baseEnv, resolved);
}
