/**
 * Provider registry & deploy config tests (OLO-2.3, #4195).
 *
 * The registry is the single surface deciding which sign-in providers a deployment enables,
 * purely from env. These tests pin:
 *
 *   1. The registry vocabulary — ids, labels, statuses, and each provider's env contract.
 *   2. Enablement semantics — all required env vars set + non-blank; blanks count as unset;
 *      `coming-soon` and unknown ids are never enabled.
 *   3. The acceptance criteria — enabling/disabling a provider via env alone adds/removes it
 *      from the enabled set (no code changes).
 *   4. Delegation — `isEntraIdConfigured` (OLO-2.1) resolves through the registry, so the
 *      azure env contract cannot drift between the two modules.
 *   5. Route contracts (source level) — the signup-intent and link routes gate on the
 *      registry, and the NextAuth route registers providers from it.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  PROVIDER_REGISTRY,
  enabledProviderIds,
  enabledProviders,
  getProviderDescriptor,
  isProviderEnabled,
  providerSummaries,
  readEnvString,
} from '../lib/auth/provider-registry';
import { isEntraIdConfigured } from '../lib/auth/entra-provider';

/** Env enabling every available provider. */
const ALL_ENABLED_ENV = {
  GITHUB_ID: 'gh-id',
  GITHUB_SECRET: 'gh-secret',
  GITLAB_CLIENT_ID: 'gl-id',
  GITLAB_CLIENT_SECRET: 'gl-secret',
  AZURE_AD_CLIENT_ID: 'az-id',
  AZURE_AD_CLIENT_SECRET: 'az-secret',
  GOOGLE_CLIENT_ID: 'gg-id',
  GOOGLE_CLIENT_SECRET: 'gg-secret',
};

describe('registry vocabulary', () => {
  it('lists every known provider in display order', () => {
    expect(PROVIDER_REGISTRY.map((p) => p.id)).toEqual([
      'github',
      'gitlab',
      'azure',
      'google',
      'aws',
    ]);
  });

  it('carries the display labels the login/link surfaces render', () => {
    expect(getProviderDescriptor('github')?.label).toBe('GitHub');
    expect(getProviderDescriptor('gitlab')?.label).toBe('GitLab');
    expect(getProviderDescriptor('azure')?.label).toBe('Microsoft');
    expect(getProviderDescriptor('google')?.label).toBe('Google');
    expect(getProviderDescriptor('aws')?.label).toBe('AWS');
  });

  it('pins each available provider env contract', () => {
    expect(getProviderDescriptor('github')?.requiredEnvKeys).toEqual(['GITHUB_ID', 'GITHUB_SECRET']);
    expect(getProviderDescriptor('gitlab')?.requiredEnvKeys).toEqual([
      'GITLAB_CLIENT_ID',
      'GITLAB_CLIENT_SECRET',
    ]);
    expect(getProviderDescriptor('azure')?.requiredEnvKeys).toEqual([
      'AZURE_AD_CLIENT_ID',
      'AZURE_AD_CLIENT_SECRET',
    ]);
    expect(getProviderDescriptor('google')?.requiredEnvKeys).toEqual([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]);
  });

  it('marks google available (OLO-9.2) and aws still coming-soon', () => {
    expect(getProviderDescriptor('google')?.status).toBe('available');
    expect(getProviderDescriptor('aws')?.status).toBe('coming-soon');
  });

  it('returns undefined for unknown ids', () => {
    expect(getProviderDescriptor('okta')).toBeUndefined();
  });
});

describe('readEnvString', () => {
  it('returns the trimmed value when set', () => {
    expect(readEnvString({ KEY: '  value  ' }, 'KEY')).toBe('value');
  });

  it('treats unset, empty, and whitespace-only values as null', () => {
    expect(readEnvString({}, 'KEY')).toBeNull();
    expect(readEnvString({ KEY: '' }, 'KEY')).toBeNull();
    expect(readEnvString({ KEY: '   ' }, 'KEY')).toBeNull();
  });
});

describe('isProviderEnabled', () => {
  it('enables a provider when all of its env vars are set and non-blank', () => {
    expect(isProviderEnabled('github', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('gitlab', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('azure', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('google', ALL_ENABLED_ENV)).toBe(true);
  });

  it('requires every env var — a missing secret disables the provider', () => {
    expect(isProviderEnabled('github', { GITHUB_ID: 'gh-id' })).toBe(false);
    expect(isProviderEnabled('gitlab', { GITLAB_CLIENT_SECRET: 'gl-secret' })).toBe(false);
  });

  it('treats blank values as unset', () => {
    expect(isProviderEnabled('github', { GITHUB_ID: 'gh-id', GITHUB_SECRET: '   ' })).toBe(false);
  });

  it('enables google once its client id + secret are set (OLO-9.2)', () => {
    expect(
      isProviderEnabled('google', { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' })
    ).toBe(true);
    expect(isProviderEnabled('google', { GOOGLE_CLIENT_ID: 'x' })).toBe(false);
  });

  it('never enables coming-soon providers, regardless of env', () => {
    expect(isProviderEnabled('aws', ALL_ENABLED_ENV)).toBe(false);
  });

  it('never enables unknown ids', () => {
    expect(isProviderEnabled('okta', ALL_ENABLED_ENV)).toBe(false);
  });
});

describe('acceptance: env alone adds/removes providers everywhere', () => {
  it('renders exactly the enabled providers', () => {
    expect(enabledProviderIds(ALL_ENABLED_ENV)).toEqual(['github', 'gitlab', 'azure', 'google']);
    expect(enabledProviderIds({ GITHUB_ID: 'gh-id', GITHUB_SECRET: 'gh-secret' })).toEqual(['github']);
    expect(enabledProviderIds({})).toEqual([]);
  });

  it('disabling a provider via env removes it without code changes', () => {
    const withoutGitlab = { ...ALL_ENABLED_ENV, GITLAB_CLIENT_ID: '' };
    expect(enabledProviderIds(withoutGitlab)).toEqual(['github', 'azure', 'google']);
  });

  it('enabledProviders preserves registry display order', () => {
    expect(enabledProviders(ALL_ENABLED_ENV).map((p) => p.id)).toEqual([
      'github',
      'gitlab',
      'azure',
      'google',
    ]);
  });
});

describe('providerSummaries', () => {
  it('summarizes every registry entry with its enabled state, serializably', () => {
    const summaries = providerSummaries({ GITHUB_ID: 'gh-id', GITHUB_SECRET: 'gh-secret' });

    expect(summaries).toEqual([
      { id: 'github', label: 'GitHub', status: 'available', enabled: true },
      { id: 'gitlab', label: 'GitLab', status: 'available', enabled: false },
      { id: 'azure', label: 'Microsoft', status: 'available', enabled: false },
      { id: 'google', label: 'Google', status: 'available', enabled: false },
      { id: 'aws', label: 'AWS', status: 'coming-soon', enabled: false },
    ]);
    // Server → client props must survive serialization untouched.
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries);
  });
});

describe('isEntraIdConfigured delegates to the registry (no env-contract drift)', () => {
  it('matches the registry verdict for configured and unconfigured envs', () => {
    expect(isEntraIdConfigured(ALL_ENABLED_ENV)).toBe(true);
    expect(isEntraIdConfigured({ AZURE_AD_CLIENT_ID: 'az-id' })).toBe(false);
    expect(isEntraIdConfigured({})).toBe(false);
  });
});

describe('route contracts (source level)', () => {
  const APP_ROOT = path.resolve(__dirname, '..', 'src', 'app');
  const read = (file: string) => fs.readFileSync(file, 'utf8');

  it('the auth route delegates to the Better Auth handler (no per-provider factories)', () => {
    const route = read(path.join(APP_ROOT, 'api', 'auth', '[...all]', 'route.ts'));
    expect(route).toContain('betterAuthHandler');
    expect(route).not.toContain('GithubProvider(');
    expect(route).not.toContain('GitlabProvider(');
  });

  it('the Better Auth provider set is built from the registry', () => {
    const providers = read(
      path.join(__dirname, '..', 'lib', 'auth', 'better-auth-oauth-providers.ts')
    );
    expect(providers).toContain('enabledProviders(');
  });

  it('the signup-intent route gates on registry enablement', () => {
    const route = read(path.join(APP_ROOT, 'api', 'auth', 'signup-intent', 'route.ts'));
    expect(route).toContain('isProviderEnabled(provider)');
  });

  it('the link route gates on registry enablement for every provider', () => {
    const route = read(path.join(APP_ROOT, 'api', 'auth', 'link', '[provider]', 'route.ts'));
    expect(route).toContain('isProviderEnabled(provider)');
    expect(route).toContain('LINKABLE_PROVIDERS.has(provider)');
  });

  it('the login and linked-accounts pages resolve providers server-side', () => {
    const loginPage = read(path.join(APP_ROOT, 'login', 'page.tsx'));
    const linkedAccountsPage = read(
      path.join(APP_ROOT, 'ade', 'dashboard', 'linked-accounts', 'page.tsx')
    );
    expect(loginPage).toContain('providerSummaries()');
    expect(linkedAccountsPage).toContain('providerSummaries()');
  });
});
