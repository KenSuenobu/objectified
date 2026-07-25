/**
 * @jest-environment node
 *
 * Identity-slug vocabulary parity under the Better Auth engine (OLO-10.9, #5004).
 *
 * The `apiome.external_auth_providers.provider` column is the OLO-2.2 identity vocabulary, bounded by
 * a DB CHECK (`external_auth_providers_provider_supported_ck`, narrowed in V181 and widened in V198).
 * The account-resolution engine writes that column with the provider slug verbatim, and the Better
 * Auth `account.providerId` column is backfilled from it (V199). For the vocabulary to hold under
 * `AUTH_ENGINE=better-auth`, three things must line up and stay lined up:
 *
 *   1. every enabled registry id — and every slug the resolution/adapter gates dispatch on — is a
 *      value the DB CHECK actually permits, so a persisted identity can never violate the constraint;
 *   2. the Better Auth OAuth adapter drives the resolution store with that same slug, so an identity
 *      persists under the correct value on the Better Auth path (not just the NextAuth one);
 *   3. the V199 backfill maps `external_auth_providers.provider → account."providerId"`, so Better
 *      Auth's account table inherits the identity vocabulary rather than a divergent one.
 *
 * The DB CHECK vocabulary is parsed straight from the migration so this test tracks the real
 * constraint and fails if the TS registry/gates ever drift from it (a slug added to the registry but
 * not the CHECK would fail the INSERT at runtime; this catches it at build time instead).
 */

import * as fs from 'fs';
import * as path from 'path';

// `better-auth/api` is ESM-only; stub createAuthMiddleware (the adapter imports it at module load).
jest.mock('better-auth/api', () => ({ createAuthMiddleware: (handler: unknown) => handler }));
// The default production store imports the db layer; every test injects its own store, so stub the
// module to keep the suite hermetic (no DB connection).
jest.mock('../lib/auth/resolution-store', () => ({ resolutionStore: {} }));

import { describe, test, expect } from '@jest/globals';

import { PROVIDER_REGISTRY } from '../lib/auth/provider-registry';
import {
  AUTO_LINK_TRUSTED_PROVIDERS,
  LINKABLE_PROVIDERS,
  type ResolutionStore,
  type ResolutionUser,
} from '../lib/auth/account-resolution';
import {
  SUPPORTED_OAUTH_PROVIDERS,
  resolveBetterAuthOAuthSignIn,
  type BetterAuthOAuthContext,
} from '../lib/auth/better-auth-account-resolution';

/* ── DB CHECK vocabulary, parsed from the migration ───────────────────────────────────────────── */

const DB_SCRIPTS = path.join(__dirname, '..', '..', 'apiome-db', 'scripts');
const V198 = path.join(DB_SCRIPTS, 'V198__auth_provider_vocabulary_4984.sql');
const V199 = path.join(DB_SCRIPTS, 'V199__better_auth_core_tables_4999.sql');
/** Latest vocabulary widen (WeChat / OLO-9.43); supersedes V203 for the live CHECK set. */
const V204 = path.join(DB_SCRIPTS, 'V204__auth_provider_vocabulary_wechat_5056.sql');

/**
 * Extract the single-quoted slug list from a named `ADD CONSTRAINT … CHECK (… IN ( … ))` block.
 *
 * @param sql The migration SQL.
 * @param constraint The constraint name whose vocabulary to read.
 * @returns The set of permitted slugs.
 */
function checkVocabulary(sql: string, constraint: string): Set<string> {
  const start = sql.indexOf(`ADD CONSTRAINT ${constraint}`);
  if (start === -1) throw new Error(`constraint '${constraint}' not found in migration`);
  const end = sql.indexOf(';', start);
  const block = sql.slice(start, end === -1 ? undefined : end);
  const slugs = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((match) => match[1]);
  if (slugs.length === 0) throw new Error(`no slugs parsed for constraint '${constraint}'`);
  return new Set(slugs);
}

const V198_SQL = fs.readFileSync(V198, 'utf8');
const V199_SQL = fs.readFileSync(V199, 'utf8');
const V204_SQL = fs.readFileSync(V204, 'utf8');
/** The effective identity vocabulary the DB permits (latest widen: V204 / OLO-9.43). */
const IDENTITY_VOCABULARY = checkVocabulary(V204_SQL, 'external_auth_providers_provider_supported_ck');

/** The registry ids that are actually enabled (available), i.e. the live sign-in providers. */
const ENABLED_IDS = PROVIDER_REGISTRY.filter((provider) => provider.status === 'available').map(
  (provider) => provider.id
);

/* ── Fake resolution store (mirrors the adapter suite) ────────────────────────────────────────── */

const OK_USER: ResolutionUser = {
  id: 'user-ok',
  enabled: true,
  verified: true,
  email: 'ada@example.com',
  name: 'Ada',
};

function makeStore(config: { identityUserId?: string; usersByEmail?: Record<string, ResolutionUser> }) {
  const calls = {
    linkIdentity: [] as Array<{ userId: string; identity: unknown }>,
    recordIdentityLogin: [] as Array<{ provider: string; providerUserId: string }>,
  };
  const store: ResolutionStore = {
    async getIdentity() {
      return config.identityUserId
        ? { found: true, userId: config.identityUserId }
        : { found: false, userId: null };
    },
    async getUserById(userId) {
      return userId === OK_USER.id ? OK_USER : null;
    },
    async getUserByEmail(email) {
      return config.usersByEmail?.[email] ?? null;
    },
    async linkIdentity(userId, identity) {
      calls.linkIdentity.push({ userId, identity });
      return { success: true };
    },
    async recordIdentityLogin(provider, providerUserId) {
      calls.recordIdentityLogin.push({ provider, providerUserId });
    },
    async recordUserLogin() {},
    async createPendingSignup() {
      return { id: 'pending-1' };
    },
  };
  return { store, calls };
}

/** A verified-email OAuth callback context for the given provider slug. */
const makeCtx = (): BetterAuthOAuthContext => ({
  accountId: 'prov-123',
  profile: { email: 'ada@example.com', email_verified: true, login: 'ada', name: 'Ada' },
  tokens: { accessToken: 'tok', refreshToken: null, accessTokenExpiresAt: null },
});

/* ── 1. The TS slug sets are all within the DB CHECK vocabulary ───────────────────────────────── */

describe('slug vocabulary parity: registry & resolution gates ⊆ the DB CHECK', () => {
  test('the enabled registry ids are exactly the live available providers', () => {
    expect([...ENABLED_IDS].sort()).toEqual([
      'auth0',
      'aws',
      'azure',
      'github',
      'gitlab',
      'google',
      'keycloak',
      'line',
      'oidc',
      'okta',
      'vk',
      'wechat',
    ]);
  });

  test('every enabled registry id is permitted by the external_auth_providers CHECK', () => {
    for (const id of ENABLED_IDS) {
      expect(IDENTITY_VOCABULARY.has(id)).toBe(true);
    }
  });

  test('every LINKABLE / AUTO_LINK_TRUSTED slug is permitted by the CHECK', () => {
    for (const slug of [...LINKABLE_PROVIDERS, ...AUTO_LINK_TRUSTED_PROVIDERS]) {
      expect(IDENTITY_VOCABULARY.has(slug)).toBe(true);
    }
  });

  test('the Better Auth adapter dispatches exactly the LINKABLE vocabulary, all CHECK-permitted', () => {
    expect([...SUPPORTED_OAUTH_PROVIDERS].sort()).toEqual([...LINKABLE_PROVIDERS].sort());
    for (const slug of SUPPORTED_OAUTH_PROVIDERS) {
      expect(IDENTITY_VOCABULARY.has(slug)).toBe(true);
    }
  });

  test('the auth_provider_config CHECK shares the same vocabulary (store ↔ identity parity)', () => {
    const configVocabulary = checkVocabulary(V204_SQL, 'auth_provider_config_provider_id_check');
    expect([...configVocabulary].sort()).toEqual([...IDENTITY_VOCABULARY].sort());
  });
});

/* ── 2. The Better Auth path persists each provider's identity under its registry slug ─────────── */

describe('identities persist under the correct slug on the Better Auth path', () => {
  test.each(ENABLED_IDS)('known-identity sign-in stamps %s under its own slug', async (id) => {
    const { store, calls } = makeStore({ identityUserId: OK_USER.id });

    const result = await resolveBetterAuthOAuthSignIn(id, makeCtx(), null, store);

    expect(result).toBe(true);
    expect(calls.recordIdentityLogin).toEqual([{ provider: id, providerUserId: 'prov-123' }]);
  });

  test('auto-link INSERTs the identity row under the registry slug (github)', async () => {
    const { store, calls } = makeStore({ usersByEmail: { 'ada@example.com': OK_USER } });

    const result = await resolveBetterAuthOAuthSignIn('github', makeCtx(), null, store);

    expect(result).toBe(true);
    expect(calls.linkIdentity).toHaveLength(1);
    expect(calls.linkIdentity[0].identity).toMatchObject({ provider: 'github' });
  });

  test('a slug outside the linkable vocabulary is refused, never persisted', async () => {
    // `atlassian` is in the DB CHECK (forward-looking for OLO-9.8) but not yet linkable, so the
    // adapter refuses it before any write — LINKABLE_PROVIDERS, not the CHECK, is the dispatch gate.
    const { store, calls } = makeStore({ identityUserId: OK_USER.id });

    const result = await resolveBetterAuthOAuthSignIn('atlassian', makeCtx(), null, store);

    expect(result).toBe('/login?error=provider-not-configured');
    expect(calls.recordIdentityLogin).toHaveLength(0);
    expect(calls.linkIdentity).toHaveLength(0);
  });
});

/* ── 3. The Better Auth account table inherits the vocabulary via the V199 backfill ───────────── */

describe('Better Auth account.providerId inherits the identity vocabulary (V199 backfill)', () => {
  test('the backfill maps external_auth_providers.provider → account."providerId"', () => {
    // The backfill SELECTs eap.provider into the "providerId" column, so the account table carries the
    // same slug vocabulary as external_auth_providers rather than a divergent one.
    expect(V199_SQL).toMatch(/INSERT INTO apiome\.account/);
    expect(V199_SQL).toMatch(/"providerId"/);
    expect(V199_SQL).toMatch(/eap\.provider\b/);
    expect(V199_SQL).toMatch(/FROM apiome\.external_auth_providers/);
  });
});
