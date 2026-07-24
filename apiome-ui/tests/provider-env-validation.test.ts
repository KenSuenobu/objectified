/**
 * Boot-time provider env validation tests (OLO-7.2, #4224).
 *
 * The acceptance criterion: missing/partial provider env fails startup with a clear
 * message, or cleanly disables that provider, per config. These tests pin:
 *
 *   1. Issue detection — fully-set and fully-unset providers are valid; some-but-not-all
 *      is an issue; blanks count as unset (matching `isProviderEnabled` semantics).
 *   2. Message quality — every issue names the provider, the missing and present vars,
 *      both resolutions (set all / unset all), and points at the setup guide.
 *   3. Mode resolution — `strict` by default, `warn` opt-in, anything else is itself an
 *      error so a typo cannot silently weaken validation.
 *   4. `validateProviderEnv` behavior — strict throws with every issue aggregated; warn
 *      logs each issue and returns them; a coherent env is silent in both modes.
 *   5. Boot contract (source level) — `src/instrumentation.ts` runs the validation on the
 *      Node.js runtime at server startup.
 *   6. Docs contract — the setup guide and `.env.example` cover every required env var of
 *      every available provider, the validation mode var, and the Entra `xms_edov` claim.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  PROVIDER_REGISTRY,
  PROVIDER_VALIDATION_ENV_KEY,
  ProviderDescriptor,
  clientCredentialFields,
  providerEnvIssues,
  providerValidationMode,
  validateProviderEnv,
} from '../lib/auth/provider-registry';

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

describe('providerEnvIssues', () => {
  it('reports nothing when every provider is fully configured', () => {
    expect(providerEnvIssues(ALL_ENABLED_ENV)).toEqual([]);
  });

  it('reports nothing when every provider is fully unconfigured (cleanly disabled)', () => {
    expect(providerEnvIssues({})).toEqual([]);
  });

  it('reports a partially configured provider with its missing and present keys', () => {
    const issues = providerEnvIssues({ GITHUB_ID: 'gh-id' });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      providerId: 'github',
      label: 'GitHub',
      presentKeys: ['GITHUB_ID'],
      missingKeys: ['GITHUB_SECRET'],
    });
  });

  it('treats blank values as unset, matching enablement semantics', () => {
    const issues = providerEnvIssues({ GITLAB_CLIENT_ID: 'gl-id', GITLAB_CLIENT_SECRET: '   ' });

    expect(issues).toHaveLength(1);
    expect(issues[0].providerId).toBe('gitlab');
    expect(issues[0].missingKeys).toEqual(['GITLAB_CLIENT_SECRET']);
  });

  it('reports one issue per partially configured provider, in registry order', () => {
    const issues = providerEnvIssues({ GITHUB_SECRET: 'gh-secret', AZURE_AD_CLIENT_ID: 'az-id' });

    expect(issues.map((issue) => issue.providerId)).toEqual(['github', 'azure']);
  });

  it('ignores extra unrelated env and coming-soon providers', () => {
    // aws is coming-soon (no env contract) and AWS_ACCESS_KEY_ID / an unrelated var map to no
    // required field, so neither can produce a partial-config issue.
    const issues = providerEnvIssues({
      ...ALL_ENABLED_ENV,
      AWS_ACCESS_KEY_ID: 'aws-key',
      SOME_UNRELATED_VAR: 'x',
    });

    expect(issues).toEqual([]);
  });

  it('writes an actionable message: provider, vars, both resolutions, setup guide', () => {
    const [issue] = providerEnvIssues({ AZURE_AD_CLIENT_SECRET: 'az-secret' });

    expect(issue.message).toContain("'Microsoft' (azure)");
    expect(issue.message).toContain('AZURE_AD_CLIENT_ID is unset or blank');
    expect(issue.message).toContain('AZURE_AD_CLIENT_SECRET is set');
    expect(issue.message).toContain('Set all of AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET');
    expect(issue.message).toContain('or unset all of them to disable it');
    expect(issue.message).toContain('docs/AUTH_PROVIDER_SETUP.md');
  });
});

describe('issuer-aware required fields (OLO-9.1)', () => {
  // A representative issuer-based provider (Okta/Auth0/OIDC shape, OLO-9.3–9.7): client id +
  // secret plus a config-kind `issuer` field. Injected into the validation so the capability is
  // exercised without shipping a half-built provider entry in the real registry.
  const OKTA: ProviderDescriptor = {
    id: 'okta',
    label: 'Okta',
    status: 'available',
    requiredFields: [
      ...clientCredentialFields('OKTA_CLIENT_ID', 'OKTA_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'OKTA_ISSUER' },
    ],
    requiredEnvKeys: ['OKTA_CLIENT_ID', 'OKTA_CLIENT_SECRET', 'OKTA_ISSUER'],
  };
  const ISSUER_REGISTRY = [OKTA];

  const FULL_TRIO = {
    OKTA_CLIENT_ID: 'id',
    OKTA_CLIENT_SECRET: 'secret',
    OKTA_ISSUER: 'https://example.okta.com',
  };

  it('derives requiredEnvKeys from requiredFields, including the issuer var', () => {
    // The registry helper materializes the env-var list from the structured fields, so the two
    // can never drift within an entry (see clientCredentialFields / buildDescriptor).
    expect(clientCredentialFields('A_ID', 'A_SECRET')).toEqual([
      { field: 'client_id', kind: 'client_id', envKey: 'A_ID' },
      { field: 'client_secret', kind: 'client_secret', envKey: 'A_SECRET' },
    ]);
  });

  it('treats the id+secret set / issuer missing trio as partial config, naming the issuer var', () => {
    const [issue] = providerEnvIssues(
      { OKTA_CLIENT_ID: 'id', OKTA_CLIENT_SECRET: 'secret' },
      ISSUER_REGISTRY
    );

    expect(issue).toMatchObject({
      providerId: 'okta',
      presentKeys: ['OKTA_CLIENT_ID', 'OKTA_CLIENT_SECRET'],
      missingKeys: ['OKTA_ISSUER'],
    });
    expect(issue.message).toContain('OKTA_ISSUER is unset or blank');
  });

  it('is silent once the whole trio (including the issuer) is set', () => {
    expect(providerEnvIssues(FULL_TRIO, ISSUER_REGISTRY)).toEqual([]);
  });

  it('strict-mode boot fails on the partial issuer trio', () => {
    expect(() =>
      validateProviderEnv({ OKTA_CLIENT_ID: 'id', OKTA_CLIENT_SECRET: 'secret' }, ISSUER_REGISTRY)
    ).toThrow(/OKTA_ISSUER is unset or blank/);
  });

  it('strict-mode boot passes once the issuer is also set', () => {
    expect(validateProviderEnv(FULL_TRIO, ISSUER_REGISTRY)).toEqual([]);
  });
});

describe('providerValidationMode', () => {
  it('defaults to strict when unset or blank', () => {
    expect(providerValidationMode({})).toBe('strict');
    expect(providerValidationMode({ [PROVIDER_VALIDATION_ENV_KEY]: '  ' })).toBe('strict');
  });

  it('accepts strict and warn, case-insensitively', () => {
    expect(providerValidationMode({ [PROVIDER_VALIDATION_ENV_KEY]: 'strict' })).toBe('strict');
    expect(providerValidationMode({ [PROVIDER_VALIDATION_ENV_KEY]: 'warn' })).toBe('warn');
    expect(providerValidationMode({ [PROVIDER_VALIDATION_ENV_KEY]: 'WARN' })).toBe('warn');
  });

  it('rejects any other value so a typo cannot weaken validation', () => {
    expect(() => providerValidationMode({ [PROVIDER_VALIDATION_ENV_KEY]: 'off' })).toThrow(
      /AUTH_PROVIDER_VALIDATION='off' is not a valid validation mode.*'strict'.*'warn'/s
    );
  });
});

describe('validateProviderEnv', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('is silent for a coherent env, in both modes', () => {
    expect(validateProviderEnv(ALL_ENABLED_ENV)).toEqual([]);
    expect(validateProviderEnv({ [PROVIDER_VALIDATION_ENV_KEY]: 'warn' })).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('strict (default): fails startup, aggregating every issue with the warn escape hatch', () => {
    const env = { GITHUB_ID: 'gh-id', GITLAB_CLIENT_SECRET: 'gl-secret' };

    expect(() => validateProviderEnv(env)).toThrow(
      /Refusing to start: 2 sign-in provider\(s\) partially configured/
    );
    expect(() => validateProviderEnv(env)).toThrow(/'GitHub' \(github\)/);
    expect(() => validateProviderEnv(env)).toThrow(/'GitLab' \(gitlab\)/);
    expect(() => validateProviderEnv(env)).toThrow(/AUTH_PROVIDER_VALIDATION=warn/);
  });

  it('warn: logs each issue, keeps the provider disabled, and does not throw', () => {
    const env = { GITHUB_ID: 'gh-id', [PROVIDER_VALIDATION_ENV_KEY]: 'warn' };

    const issues = validateProviderEnv(env);

    expect(issues).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("'GitHub' (github)");
    expect(warnSpy.mock.calls[0][0]).toContain('(provider disabled)');
  });

  it('rejects an invalid mode even when the provider env itself is coherent', () => {
    expect(() =>
      validateProviderEnv({ ...ALL_ENABLED_ENV, [PROVIDER_VALIDATION_ENV_KEY]: 'silent' })
    ).toThrow(/not a valid validation mode/);
  });
});

describe('boot contract (source level)', () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.resolve(__dirname, '..', ...segments), 'utf8');

  it('instrumentation.ts validates provider env on the Node.js runtime at startup', () => {
    const instrumentation = read('src', 'instrumentation.ts');

    expect(instrumentation).toContain('export async function register');
    expect(instrumentation).toContain("process.env.NEXT_RUNTIME !== 'nodejs'");
    expect(instrumentation).toContain('validateProviderEnv()');
  });
});

describe('docs contract (OLO-7.2 acceptance: guides published, env matrix documented)', () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.resolve(__dirname, '..', ...segments), 'utf8');

  const requiredKeys = PROVIDER_REGISTRY.filter((p) => p.status === 'available').flatMap(
    (p) => p.requiredEnvKeys
  );

  it('the setup guide documents every required env var and the validation mode var', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    for (const key of requiredKeys) {
      expect(guide).toContain(key);
    }
    expect(guide).toContain(PROVIDER_VALIDATION_ENV_KEY);
    expect(guide).toContain('AZURE_AD_TENANT');
  });

  it('the setup guide covers each provider callback URL and the Entra xms_edov claim', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    expect(guide).toContain('/api/auth/oauth2/callback/github');
    expect(guide).toContain('/api/auth/oauth2/callback/gitlab');
    expect(guide).toContain('/api/auth/oauth2/callback/azure');
    expect(guide).toContain('xms_edov');
    expect(guide).toContain('ENTRA_ID_APP_REGISTRATION.md');
    expect(guide).toContain('GITLAB_SSO_SETUP.md');
  });

  it('.env.example carries every required env var and the validation mode var', () => {
    const envExample = read('.env.example');

    for (const key of requiredKeys) {
      expect(envExample).toContain(key);
    }
    expect(envExample).toContain(PROVIDER_VALIDATION_ENV_KEY);
    expect(envExample).toContain('AUTH_PROVIDER_SETUP.md');
  });
});
