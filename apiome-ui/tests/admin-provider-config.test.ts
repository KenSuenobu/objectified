/**
 * Shared admin provider-config contract (OLO-8.7, #4973).
 *
 * Covers the pure pieces the settings screen is built on: the per-provider extra-field
 * metadata (must stay in lockstep with the registry and the OLO-8.5 env-key overlay), the
 * partial-update payload builder (only changed fields may reach the wire), and REST error
 * message extraction.
 */
import {
  AdminProviderConfigView,
  PROVIDER_EXTRA_FIELDS,
  buildProviderUpdatePayload,
  extractRestErrorMessage,
} from '../lib/auth/admin-provider-config';
import { PROVIDER_REGISTRY } from '../lib/auth/provider-registry';
import { PROVIDER_CRED_ENV_KEYS } from '../lib/auth/provider-config-resolver';

/** A baseline "nothing stored" view for one provider, overridable per test. */
function makeView(overrides: Partial<AdminProviderConfigView> = {}): AdminProviderConfigView {
  return {
    provider_id: 'github',
    label: 'GitHub',
    status: 'available',
    enabled: null,
    enabled_source: 'env-fallback',
    client_id: null,
    client_id_source: 'env-fallback',
    secret_set: false,
    secret_source: 'env-fallback',
    config: {},
    required_fields: ['client_id', 'client_secret'],
    missing_for_enable: ['client_id', 'client_secret'],
    can_enable: false,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

describe('PROVIDER_EXTRA_FIELDS metadata', () => {
  it('only defines extras for available registry providers', () => {
    const availableIds = PROVIDER_REGISTRY.filter((p) => p.status === 'available').map(
      (p) => p.id
    );
    for (const id of Object.keys(PROVIDER_EXTRA_FIELDS)) {
      expect(availableIds).toContain(id);
    }
  });

  it('never reuses a credential env key as an extra (extras overlay by their own key)', () => {
    const credKeys = Object.values(PROVIDER_CRED_ENV_KEYS).flatMap((keys) => [
      keys.clientId,
      keys.clientSecret,
    ]);
    for (const fields of Object.values(PROVIDER_EXTRA_FIELDS)) {
      for (const field of fields) {
        expect(credKeys).not.toContain(field.envKey);
      }
    }
  });

  it('uses unique env keys with labels, defaults, and help text', () => {
    const seen = new Set<string>();
    for (const fields of Object.values(PROVIDER_EXTRA_FIELDS)) {
      for (const field of fields) {
        expect(seen.has(field.envKey)).toBe(false);
        seen.add(field.envKey);
        expect(field.label.length).toBeGreaterThan(0);
        expect(field.defaultValue.length).toBeGreaterThan(0);
        expect(field.help.length).toBeGreaterThan(0);
      }
    }
  });

  it('covers the documented provider-specific fields from the issue', () => {
    expect(PROVIDER_EXTRA_FIELDS.azure.map((f) => f.envKey)).toEqual(
      expect.arrayContaining(['AZURE_AD_TENANT', 'AZURE_AD_AUTHORITY_BASE_URL'])
    );
    expect(PROVIDER_EXTRA_FIELDS.gitlab.map((f) => f.envKey)).toContain('GITLAB_BASE_URL');
    expect(PROVIDER_EXTRA_FIELDS.github.map((f) => f.envKey)).toEqual(
      expect.arrayContaining(['GITHUB_OAUTH_BASE_URL', 'GITHUB_API_BASE_URL'])
    );
    expect(PROVIDER_EXTRA_FIELDS.okta.map((f) => f.envKey)).toEqual(['OKTA_ISSUER']);
    expect(PROVIDER_EXTRA_FIELDS.aws.map((f) => f.envKey)).toEqual(['COGNITO_ISSUER']);
    expect(PROVIDER_EXTRA_FIELDS.keycloak.map((f) => f.envKey)).toEqual(['KEYCLOAK_ISSUER']);
  });
});

describe('buildProviderUpdatePayload', () => {
  it('returns null when nothing changed', () => {
    const view = makeView({ client_id: 'abc', config: { GITHUB_API_BASE_URL: 'x' } });
    expect(
      buildProviderUpdatePayload(view, {
        enabled: null,
        clientId: 'abc',
        clientSecret: '',
        clearSecret: false,
        extras: { GITHUB_API_BASE_URL: 'x' },
      })
    ).toBeNull();
  });

  it('returns null for an untouched card (no edit keys at all)', () => {
    expect(buildProviderUpdatePayload(makeView(), {})).toBeNull();
  });

  it('sends only a changed enablement, including the explicit null override-clear', () => {
    expect(buildProviderUpdatePayload(makeView({ enabled: null }), { enabled: true })).toEqual({
      enabled: true,
    });
    expect(buildProviderUpdatePayload(makeView({ enabled: true }), { enabled: null })).toEqual({
      enabled: null,
    });
    expect(buildProviderUpdatePayload(makeView({ enabled: true }), { enabled: true })).toBeNull();
  });

  it('trims the client id and clears it with null when blanked', () => {
    expect(buildProviderUpdatePayload(makeView(), { clientId: '  new-id  ' })).toEqual({
      client_id: 'new-id',
    });
    expect(
      buildProviderUpdatePayload(makeView({ client_id: 'old' }), { clientId: '   ' })
    ).toEqual({ client_id: null });
    expect(
      buildProviderUpdatePayload(makeView({ client_id: 'same' }), { clientId: 'same' })
    ).toBeNull();
  });

  it('sends a typed secret write-only and ignores a blank secret input', () => {
    expect(buildProviderUpdatePayload(makeView(), { clientSecret: ' s3cret ' })).toEqual({
      client_secret: 's3cret',
    });
    expect(buildProviderUpdatePayload(makeView(), { clientSecret: '   ' })).toBeNull();
  });

  it('clears a stored secret with null, and clearSecret wins over typed input', () => {
    const view = makeView({ secret_set: true, secret_source: 'db' });
    expect(
      buildProviderUpdatePayload(view, { clearSecret: true, clientSecret: 'typed' })
    ).toEqual({ client_secret: null });
  });

  it('does not send a clear for a secret that is not stored', () => {
    expect(buildProviderUpdatePayload(makeView({ secret_set: false }), { clearSecret: true })).toBeNull();
  });

  it('rebuilds the whole config for changed extras, preserving unknown keys', () => {
    const view = makeView({
      config: { GITHUB_API_BASE_URL: 'https://api.old', custom_flag: 42 },
    });
    expect(
      buildProviderUpdatePayload(view, {
        extras: { GITHUB_API_BASE_URL: ' https://api.new ', GITHUB_OAUTH_BASE_URL: '' },
      })
    ).toEqual({
      config: { GITHUB_API_BASE_URL: 'https://api.new', custom_flag: 42 },
    });
  });

  it('removes an extra cleared to blank', () => {
    const view = makeView({ config: { GITLAB_BASE_URL: 'https://git.example.com' } });
    expect(buildProviderUpdatePayload(view, { extras: { GITLAB_BASE_URL: '  ' } })).toEqual({
      config: {},
    });
  });

  it('leaves config out of the payload when extras are unchanged', () => {
    const view = makeView({ config: { GITLAB_BASE_URL: 'https://git.example.com' } });
    expect(
      buildProviderUpdatePayload(view, {
        extras: { GITLAB_BASE_URL: 'https://git.example.com' },
        clientId: 'changed',
      })
    ).toEqual({ client_id: 'changed' });
  });
});

describe('extractRestErrorMessage', () => {
  it('reads a plain-string FastAPI detail', () => {
    expect(extractRestErrorMessage({ detail: 'Unknown auth provider.' }, 'fb')).toBe(
      'Unknown auth provider.'
    );
  });

  it('reads the structured OLO-8.4 detail message', () => {
    const body = {
      detail: {
        error: 'provider_incomplete',
        provider_id: 'github',
        missing_fields: ['client_secret'],
        message: "Cannot enable 'github': missing required field client_secret.",
      },
    };
    expect(extractRestErrorMessage(body, 'fb')).toBe(
      "Cannot enable 'github': missing required field client_secret."
    );
  });

  it('summarizes pydantic validation-issue arrays instead of dumping them', () => {
    const body = { detail: [{ loc: ['body', 'enabled'], msg: 'bool expected' }] };
    expect(extractRestErrorMessage(body, 'fb')).toMatch(/rejected as invalid/);
  });

  it('reads proxy-shaped { message } bodies and falls back otherwise', () => {
    expect(extractRestErrorMessage({ message: 'REST is down.' }, 'fb')).toBe('REST is down.');
    expect(extractRestErrorMessage(null, 'fb')).toBe('fb');
    expect(extractRestErrorMessage({ detail: '' }, 'fb')).toBe('fb');
  });
});
