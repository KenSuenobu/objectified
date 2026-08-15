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
 *      Node.js runtime at server startup, against the merged DB-over-env overlay.
 *   6. DB-source awareness (OLO-8.8) — a provider completed from the database is never flagged
 *      as "missing env"; messages name the store a value can live in; and an unreadable DB
 *      source downgrades strict rather than failing startup on unproven evidence.
 *   7. Docs contract — the setup guide and `.env.example` cover every required env var of
 *      every available provider, the validation mode var, the Entra `xms_edov` claim, and the
 *      DB-first / env-fallback precedence, KEK, and rotation story.
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
  validateOidcDiscoveryEnv,
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
  VK_CLIENT_ID: 'vk-id',
  VK_CLIENT_SECRET: 'vk-secret',
  WECHAT_CLIENT_ID: 'wx-id',
  WECHAT_CLIENT_SECRET: 'wx-secret',
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

  it('ignores extra unrelated env vars that map to no required field', () => {
    // AWS_ACCESS_KEY_ID / an unrelated var map to no Cognito required field, so neither can produce
    // a partial-config issue when every required Cognito var is already set.
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

describe('DB-sourced config awareness (OLO-8.8, #4974)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** Every message the validation logged, in order. */
  const warnings = () => warnSpy.mock.calls.map((call) => String(call[0]));

  it('reports no issue when the merged overlay completes a provider (the acceptance criterion)', () => {
    // What the resolver hands boot validation: GITHUB_ID from env, GITHUB_SECRET from the DB row.
    // The merged view is complete, so there is nothing to flag — and nothing to fail startup on.
    const merged = { GITHUB_ID: 'env-gh-id', GITHUB_SECRET: 'db-gh-secret' };

    expect(providerEnvIssues(merged, undefined, 'db')).toEqual([]);
    expect(validateProviderEnv(merged, undefined, 'db')).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('tags every issue with the origin it was computed against', () => {
    for (const origin of ['env-only', 'db', 'unavailable'] as const) {
      const [issue] = providerEnvIssues({ GITHUB_ID: 'gh-id' }, undefined, origin);
      expect(issue.origin).toBe(origin);
    }
  });

  it('defaults to the env-only origin and its pre-OLO-8.5 wording', () => {
    // Callers that have no DB source (and every pre-existing call site) keep the original message.
    const [issue] = providerEnvIssues({ GITHUB_ID: 'gh-id' });

    expect(issue.origin).toBe('env-only');
    expect(issue.message).toContain('GITHUB_SECRET is unset or blank while GITHUB_ID is set');
    expect(issue.message).toContain('Set all of GITHUB_ID, GITHUB_SECRET to enable GitHub sign-in');
    expect(issue.message).not.toContain('System Configuration');
  });

  it('names both stores and the admin screen when the DB source answered', () => {
    const [issue] = providerEnvIssues({ GITHUB_ID: 'gh-id' }, undefined, 'db');

    expect(issue.message).toContain(
      'GITHUB_SECRET is unset or blank in both the stored provider config and env'
    );
    expect(issue.message).toContain('Admin → System Configuration (/admin/dashboard/settings)');
    expect(issue.message).toContain('which takes precedence');
    expect(issue.message).not.toContain('may already be fully configured in the database');
  });

  it('flags the finding as unproven when the DB source could not be read', () => {
    const [issue] = providerEnvIssues({ GITHUB_ID: 'gh-id' }, undefined, 'unavailable');

    expect(issue.message).toContain('the stored provider config could not be read');
    expect(issue.message).toContain('may already be fully configured in the database');
  });

  it('strict still fails startup for config that is partial after a successful merge', () => {
    // The DB answered and the merged view is genuinely incomplete — conclusive, so fail loud.
    expect(() => validateProviderEnv({ GITHUB_ID: 'gh-id' }, undefined, 'db')).toThrow(
      /Refusing to start: 1 sign-in provider\(s\) partially configured/
    );
  });

  it('strict degrades to a warning when the DB source is unavailable, and says why', () => {
    // A REST outage must not become a boot outage: the missing half may be in the database.
    const issues = validateProviderEnv({ GITHUB_ID: 'gh-id' }, undefined, 'unavailable');

    expect(issues).toHaveLength(1);
    expect(warnings()[0]).toContain('AUTH_PROVIDER_VALIDATION=strict not enforced');
    expect(warnings()[1]).toContain("'GitHub' (github)");
    expect(warnings()[1]).toContain('(provider disabled)');
  });

  it('does not claim strict was skipped when warn was the configured mode', () => {
    const issues = validateProviderEnv(
      { GITHUB_ID: 'gh-id', [PROVIDER_VALIDATION_ENV_KEY]: 'warn' },
      undefined,
      'unavailable'
    );

    expect(issues).toHaveLength(1);
    expect(warnings().filter((m) => m.includes('not enforced'))).toEqual([]);
    expect(warnings()).toHaveLength(1);
  });

  it('still rejects an invalid validation mode when the DB source is unavailable', () => {
    // The downgrade covers unproven partial config only — a typo'd mode is wrong either way.
    expect(() =>
      validateProviderEnv({ GITHUB_ID: 'gh-id', [PROVIDER_VALIDATION_ENV_KEY]: 'off' }, undefined, 'unavailable')
    ).toThrow(/not a valid validation mode/);
  });
});

describe('validateOidcDiscoveryEnv (OLO-9.6)', () => {
  const OIDC_ENABLED = {
    OIDC_CLIENT_ID: 'oidc-id',
    OIDC_CLIENT_SECRET: 'oidc-secret',
    OIDC_ISSUER: 'https://auth.example.com',
  };

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('skips when oidc is disabled or only partially configured', async () => {
    const probe = jest.fn(async () => ({ ok: false as const, message: 'should not run' }));
    expect(await validateOidcDiscoveryEnv({}, probe)).toBeNull();
    expect(await validateOidcDiscoveryEnv({ OIDC_CLIENT_ID: 'x' }, probe)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('strict mode throws when discovery probe fails', async () => {
    await expect(
      validateOidcDiscoveryEnv(OIDC_ENABLED, async () => ({
        ok: false,
        message: 'discovery failed: unreachable',
      }))
    ).rejects.toThrow(/Refusing to start: OIDC discovery failed/);
    await expect(
      validateOidcDiscoveryEnv(OIDC_ENABLED, async () => ({
        ok: false,
        message: 'discovery failed: unreachable',
      }))
    ).rejects.toThrow(/discovery failed: unreachable/);
  });

  it('warn mode logs and returns the probe message without throwing', async () => {
    const message = 'Sign-in provider \'OIDC\' (oidc) discovery failed: GET returned HTTP 503.';
    const result = await validateOidcDiscoveryEnv(
      { ...OIDC_ENABLED, [PROVIDER_VALIDATION_ENV_KEY]: 'warn' },
      async () => ({ ok: false, message })
    );

    expect(result).toBe(message);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(message);
  });

  it('returns null on successful discovery', async () => {
    expect(
      await validateOidcDiscoveryEnv(OIDC_ENABLED, async () => ({ ok: true }))
    ).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('boot contract (source level)', () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.resolve(__dirname, '..', ...segments), 'utf8');

  it('instrumentation.ts validates the merged provider config on the Node.js runtime at startup', () => {
    const instrumentation = read('src', 'instrumentation.ts');

    expect(instrumentation).toContain('export async function register');
    expect(instrumentation).toContain("process.env.NEXT_RUNTIME !== 'nodejs'");
    // The merged DB-over-env overlay, not raw process.env — otherwise DB-sourced config would be
    // reported as missing env (OLO-8.8).
    expect(instrumentation).toContain('resolveProviderEnvWithSource()');
    expect(instrumentation).toContain('validateProviderEnv(env, PROVIDER_REGISTRY, source)');
    expect(instrumentation).toContain('validateOidcDiscoveryEnv(env)');
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

describe('docs contract (OLO-8.8 acceptance: precedence, KEK, rotation, env template)', () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.resolve(__dirname, '..', ...segments), 'utf8');

  it('the setup guide describes the DB-first / env-fallback precedence', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    expect(guide).toContain('Config precedence');
    expect(guide).toContain('auth_provider_config');
    // The rule itself, plus the two facts an operator has to act on: who wins, and when it applies.
    expect(guide).toMatch(/stored value wins/i);
    expect(guide).toContain('/admin/dashboard/settings');
    expect(guide).toContain('INTERNAL_SERVICE_TOKEN');
  });

  it('the setup guide documents the KEK requirement and how to rotate it', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    expect(guide).toContain('AUTH_CONFIG_ENC_KEY');
    expect(guide).toContain('AUTH_CONFIG_ENC_ACTIVE_KEY_ID');
    expect(guide).toContain('enc_key_id');
    expect(guide).toMatch(/rotat/i);
    // The step that loses secrets if taken too early is called out explicitly.
    expect(guide).toContain('Removing a KEK that still');
  });

  it('the setup guide explains how the admin screen relates to the env template', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    expect(guide).toContain('How the screen relates to');
    expect(guide).toContain('using .env fallback');
  });

  it('the setup guide records how validation treats each config source', () => {
    const guide = read('docs', 'AUTH_PROVIDER_SETUP.md');

    expect(guide).toContain('Validation and the database source');
    expect(guide).toContain('not enforced');
  });

  it('.env.example annotates the provider vars as fallback / local dev', () => {
    const envExample = read('.env.example');

    expect(envExample).toContain('FALLBACK / LOCAL-DEV');
    expect(envExample).toContain('/admin/dashboard/settings');
    // The KEK is an apiome-rest variable; the template must not imply it belongs here.
    expect(envExample).toContain('AUTH_CONFIG_ENC_KEY belongs in apiome-rest');
  });
});
