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
  OKTA_CLIENT_ID: 'ok-id',
  OKTA_CLIENT_SECRET: 'ok-secret',
  OKTA_ISSUER: 'https://example.okta.com/oauth2/default',
  COGNITO_CLIENT_ID: 'cg-id',
  COGNITO_CLIENT_SECRET: 'cg-secret',
  COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf',
  KEYCLOAK_CLIENT_ID: 'kc-id',
  KEYCLOAK_CLIENT_SECRET: 'kc-secret',
  KEYCLOAK_ISSUER: 'https://kc.example.com/realms/apiome',
  OIDC_CLIENT_ID: 'oidc-id',
  OIDC_CLIENT_SECRET: 'oidc-secret',
  OIDC_ISSUER: 'https://auth.example.com',
  AUTH0_CLIENT_ID: 'a0-id',
  AUTH0_CLIENT_SECRET: 'a0-secret',
  AUTH0_ISSUER: 'https://acme.auth0.com',
  LINE_CLIENT_ID: 'line-id',
  LINE_CLIENT_SECRET: 'line-secret',
};

describe('registry vocabulary', () => {
  it('lists every known provider in display order', () => {
    expect(PROVIDER_REGISTRY.map((p) => p.id)).toEqual([
      'github',
      'gitlab',
      'azure',
      'google',
      'okta',
      'aws',
      'keycloak',
      'oidc',
      'auth0',
      'line',
    ]);
  });

  it('carries the display labels the login/link surfaces render', () => {
    expect(getProviderDescriptor('github')?.label).toBe('GitHub');
    expect(getProviderDescriptor('gitlab')?.label).toBe('GitLab');
    expect(getProviderDescriptor('azure')?.label).toBe('Microsoft');
    expect(getProviderDescriptor('google')?.label).toBe('Google');
    expect(getProviderDescriptor('okta')?.label).toBe('Okta');
    expect(getProviderDescriptor('aws')?.label).toBe('AWS');
    expect(getProviderDescriptor('keycloak')?.label).toBe('Keycloak');
    expect(getProviderDescriptor('oidc')?.label).toBe('OIDC');
    expect(getProviderDescriptor('auth0')?.label).toBe('Auth0');
    expect(getProviderDescriptor('line')?.label).toBe('LINE');
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
    expect(getProviderDescriptor('okta')?.requiredEnvKeys).toEqual([
      'OKTA_CLIENT_ID',
      'OKTA_CLIENT_SECRET',
      'OKTA_ISSUER',
    ]);
    expect(getProviderDescriptor('aws')?.requiredEnvKeys).toEqual([
      'COGNITO_CLIENT_ID',
      'COGNITO_CLIENT_SECRET',
      'COGNITO_ISSUER',
    ]);
    expect(getProviderDescriptor('keycloak')?.requiredEnvKeys).toEqual([
      'KEYCLOAK_CLIENT_ID',
      'KEYCLOAK_CLIENT_SECRET',
      'KEYCLOAK_ISSUER',
    ]);
    expect(getProviderDescriptor('oidc')?.requiredEnvKeys).toEqual([
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_ISSUER',
    ]);
    expect(getProviderDescriptor('auth0')?.requiredEnvKeys).toEqual([
      'AUTH0_CLIENT_ID',
      'AUTH0_CLIENT_SECRET',
      'AUTH0_ISSUER',
    ]);
    expect(getProviderDescriptor('line')?.requiredEnvKeys).toEqual([
      'LINE_CLIENT_ID',
      'LINE_CLIENT_SECRET',
    ]);
  });

  it('marks google/okta/aws/keycloak/oidc/auth0/line available (OLO-9.2–9.7, 9.41); no coming-soon placeholders remain', () => {
    expect(getProviderDescriptor('google')?.status).toBe('available');
    expect(getProviderDescriptor('okta')?.status).toBe('available');
    expect(getProviderDescriptor('aws')?.status).toBe('available');
    expect(getProviderDescriptor('keycloak')?.status).toBe('available');
    expect(getProviderDescriptor('oidc')?.status).toBe('available');
    expect(getProviderDescriptor('auth0')?.status).toBe('available');
    expect(getProviderDescriptor('line')?.status).toBe('available');
    expect(PROVIDER_REGISTRY.every((p) => p.status === 'available')).toBe(true);
  });

  it('returns undefined for unknown ids', () => {
    expect(getProviderDescriptor('not-a-provider')).toBeUndefined();
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
    expect(isProviderEnabled('okta', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('aws', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('keycloak', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('oidc', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('auth0', ALL_ENABLED_ENV)).toBe(true);
    expect(isProviderEnabled('line', ALL_ENABLED_ENV)).toBe(true);
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

  it('requires the Okta issuer trio (OLO-9.3) — id+secret alone is not enough', () => {
    expect(
      isProviderEnabled('okta', {
        OKTA_CLIENT_ID: 'x',
        OKTA_CLIENT_SECRET: 'y',
        OKTA_ISSUER: 'https://acme.okta.com/oauth2/default',
      })
    ).toBe(true);
    expect(
      isProviderEnabled('okta', { OKTA_CLIENT_ID: 'x', OKTA_CLIENT_SECRET: 'y' })
    ).toBe(false);
  });

  it('requires the Cognito issuer trio (OLO-9.4) — id+secret alone is not enough', () => {
    expect(
      isProviderEnabled('aws', {
        COGNITO_CLIENT_ID: 'x',
        COGNITO_CLIENT_SECRET: 'y',
        COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf',
      })
    ).toBe(true);
    expect(
      isProviderEnabled('aws', { COGNITO_CLIENT_ID: 'x', COGNITO_CLIENT_SECRET: 'y' })
    ).toBe(false);
  });

  it('requires the Keycloak issuer trio (OLO-9.5) — id+secret alone is not enough', () => {
    expect(
      isProviderEnabled('keycloak', {
        KEYCLOAK_CLIENT_ID: 'x',
        KEYCLOAK_CLIENT_SECRET: 'y',
        KEYCLOAK_ISSUER: 'https://kc.example.com/realms/apiome',
      })
    ).toBe(true);
    expect(
      isProviderEnabled('keycloak', { KEYCLOAK_CLIENT_ID: 'x', KEYCLOAK_CLIENT_SECRET: 'y' })
    ).toBe(false);
  });

  it('requires the OIDC issuer trio (OLO-9.6) — id+secret alone is not enough', () => {
    expect(
      isProviderEnabled('oidc', {
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'y',
        OIDC_ISSUER: 'https://auth.example.com',
      })
    ).toBe(true);
    expect(
      isProviderEnabled('oidc', { OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y' })
    ).toBe(false);
  });

  it('requires the Auth0 issuer trio (OLO-9.7) — id+secret alone is not enough', () => {
    expect(
      isProviderEnabled('auth0', {
        AUTH0_CLIENT_ID: 'x',
        AUTH0_CLIENT_SECRET: 'y',
        AUTH0_ISSUER: 'https://acme.auth0.com',
      })
    ).toBe(true);
    expect(
      isProviderEnabled('auth0', { AUTH0_CLIENT_ID: 'x', AUTH0_CLIENT_SECRET: 'y' })
    ).toBe(false);
    expect(
      isProviderEnabled('line', {
        LINE_CLIENT_ID: 'x',
        LINE_CLIENT_SECRET: 'y',
      })
    ).toBe(true);
    expect(isProviderEnabled('line', { LINE_CLIENT_ID: 'x' })).toBe(false);
  });

  it('never enables unknown ids', () => {
    expect(isProviderEnabled('not-a-provider', ALL_ENABLED_ENV)).toBe(false);
  });
});

describe('acceptance: env alone adds/removes providers everywhere', () => {
  it('renders exactly the enabled providers', () => {
    expect(enabledProviderIds(ALL_ENABLED_ENV)).toEqual([
      'github',
      'gitlab',
      'azure',
      'google',
      'okta',
      'aws',
      'keycloak',
      'oidc',
      'auth0',
      'line',
    ]);
    expect(enabledProviderIds({ GITHUB_ID: 'gh-id', GITHUB_SECRET: 'gh-secret' })).toEqual(['github']);
    expect(enabledProviderIds({})).toEqual([]);
  });

  it('disabling a provider via env removes it without code changes', () => {
    const withoutGitlab = { ...ALL_ENABLED_ENV, GITLAB_CLIENT_ID: '' };
    expect(enabledProviderIds(withoutGitlab)).toEqual([
      'github',
      'azure',
      'google',
      'okta',
      'aws',
      'keycloak',
      'oidc',
      'auth0',
      'line',
    ]);
  });

  it('enabledProviders preserves registry display order', () => {
    expect(enabledProviders(ALL_ENABLED_ENV).map((p) => p.id)).toEqual([
      'github',
      'gitlab',
      'azure',
      'google',
      'okta',
      'aws',
      'keycloak',
      'oidc',
      'auth0',
      'line',
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
      { id: 'okta', label: 'Okta', status: 'available', enabled: false },
      { id: 'aws', label: 'AWS', status: 'available', enabled: false },
      { id: 'keycloak', label: 'Keycloak', status: 'available', enabled: false },
      { id: 'oidc', label: 'OIDC', status: 'available', enabled: false },
      { id: 'auth0', label: 'Auth0', status: 'available', enabled: false },
      { id: 'line', label: 'LINE', status: 'available', enabled: false },
    ]);
    // Server → client props must survive serialization untouched.
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries);
  });

  it('overrides the oidc label from OIDC_DISPLAY_NAME when set (OLO-9.6)', () => {
    const summaries = providerSummaries({
      OIDC_DISPLAY_NAME: 'Authentik',
    });
    const oidc = summaries.find((s) => s.id === 'oidc');
    expect(oidc?.label).toBe('Authentik');
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
