/**
 * Environment assembly for the OLO-7.4 end-to-end journey suite (#4226).
 *
 * The journey drives the real Next.js app against the real REST API + Postgres, with only
 * the OAuth providers mocked (`e2e/support/mock-oauth-server.mjs`). This module is the one
 * place that decides ports, URLs, and the env the app under test boots with, shared by
 * `playwright.journey.config.ts`, the global setup, and the DB seed helper.
 *
 * Local defaults come from `apiome-ui/.env` (the same file `yarn dev` sources); anything
 * already present in the caller's environment wins over the file, and the mock-provider
 * overrides always win over both — the app must never reach a real provider in this suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Port the journey's Next.js dev server listens on (distinct from the usual 3000). */
export const UI_PORT = Number(process.env.JOURNEY_UI_PORT || 3100);

/** Port of the mock OAuth/OIDC provider server. */
export const MOCK_OAUTH_PORT = Number(process.env.MOCK_OAUTH_PORT || 8091);

/** Base URL of the app under test. */
export const BASE_URL = `http://localhost:${UI_PORT}`;

/** Base URL of the mock provider server. */
export const MOCK_OAUTH_URL = `http://localhost:${MOCK_OAUTH_PORT}`;

let cachedDotEnv: Record<string, string> | null = null;

/** REST API base the app (and the readiness probe) targets. */
export function restApiBaseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_REST_API_BASE_URL ||
    dotEnvValues().NEXT_PUBLIC_REST_API_BASE_URL ||
    'http://localhost:8000/v1'
  );
}

/**
 * Parse `apiome-ui/.env` into a key/value map (KEY=VALUE lines; comments, blanks, and
 * `export ` prefixes ignored; surrounding single/double quotes stripped). Deliberately
 * minimal — it only needs to cover the shapes setup.sh writes.
 *
 * @returns The parsed values, or an empty map when the file does not exist.
 */
export function dotEnvValues(): Record<string, string> {
  if (cachedDotEnv) return cachedDotEnv;
  const path = resolve(__dirname, '../../../.env');
  const values: Record<string, string> = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (rawValue.startsWith('#')) continue;
      values[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  cachedDotEnv = values;
  return values;
}

/**
 * The Postgres connection string the journey uses for seeding and invariant checks —
 * the same database the app under test writes to.
 *
 * @returns The `DATABASE_URL` from the environment or `.env`.
 * @throws Error when neither source provides one (the suite cannot run without a DB).
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL || dotEnvValues().DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set (env or apiome-ui/.env). The OLO journey needs the same ' +
        'Postgres the app uses — bring up the stack with `docker compose up` first.'
    );
  }
  return url;
}

/**
 * Build the full environment for the Next.js dev server under test.
 *
 * Precedence (last wins): `.env` file → caller's environment → mock-provider overrides.
 * `APIOME_LOAD_DOTENV=0` stops `scripts/run.sh` from re-sourcing `.env` over these values.
 *
 * @returns Env map to pass to the Playwright `webServer` entry.
 */
export function journeyServerEnv(): Record<string, string> {
  const fromProcess: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') fromProcess[key] = value;
  }
  return {
    ...dotEnvValues(),
    ...fromProcess,
    APIOME_LOAD_DOTENV: '0',
    // Better Auth is the only engine since the OLO-10.14 cutover (no engine flag). Its secret/baseURL
    // fall back to the NEXTAUTH_* values set below (see better-auth-session.ts), so no extra
    // Better-Auth-specific env is required for the mocked stack.
    NEXTAUTH_URL: BASE_URL,
    NEXTAUTH_SECRET:
      process.env.NEXTAUTH_SECRET || dotEnvValues().NEXTAUTH_SECRET || 'olo-journey-secret',
    DATABASE_URL: databaseUrl(),
    NEXT_PUBLIC_REST_API_BASE_URL: restApiBaseUrl(),
    // Every MVP provider is enabled with mock credentials; the URL overrides (OLO-7.4)
    // point each one at the local mock server. Strict boot validation stays on so a
    // partially-wired provider fails the suite loudly.
    AUTH_PROVIDER_VALIDATION: 'strict',
    GITHUB_ID: 'mock-github-client',
    GITHUB_SECRET: 'mock-github-secret',
    GITHUB_OAUTH_BASE_URL: `${MOCK_OAUTH_URL}/github`,
    GITHUB_API_BASE_URL: `${MOCK_OAUTH_URL}/github/api`,
    GITLAB_CLIENT_ID: 'mock-gitlab-client',
    GITLAB_CLIENT_SECRET: 'mock-gitlab-secret',
    GITLAB_BASE_URL: `${MOCK_OAUTH_URL}/gitlab`,
    AZURE_AD_CLIENT_ID: 'mock-azure-client',
    AZURE_AD_CLIENT_SECRET: 'mock-azure-secret',
    AZURE_AD_TENANT: 'mock-tenant',
    AZURE_AD_AUTHORITY_BASE_URL: `${MOCK_OAUTH_URL}/azure`,
    // Google (4th provider, OLO-10.13): enabled by client id/secret; `GOOGLE_ISSUER` points OIDC
    // discovery at the mock (`${MOCK}/google/.well-known/openid-configuration`). No workspace-domain
    // (`hd`) gate is set, so any mocked Google account is accepted.
    GOOGLE_CLIENT_ID: 'mock-google-client',
    GOOGLE_CLIENT_SECRET: 'mock-google-secret',
    GOOGLE_ISSUER: `${MOCK_OAUTH_URL}/google`,
  };
}
