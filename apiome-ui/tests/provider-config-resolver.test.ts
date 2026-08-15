/**
 * DB-over-env merge resolver tests (OLO-8.5, #4971).
 *
 * `provider-config-resolver.ts` fetches decrypted provider config from apiome-rest's
 * service-token-gated resolved endpoint and returns an env-shaped overlay: DB value where set, else
 * `process.env`. These tests pin the acceptance criteria:
 *
 *   - the {DB set / DB partial / DB absent} × {github, gitlab, azure} parity matrix,
 *   - blank DB field ⇒ fallback (not "disabled"),
 *   - `enabled === false` pins a provider off,
 *   - the TTL cache is bounded and invalidatable,
 *   - every failure mode (no token, non-200, network error) degrades to env — never throws,
 *   - the merged env drives `isProviderEnabled` unchanged,
 *   - and (OLO-8.8) the resolver reports *which* source produced the overlay, so boot validation can
 *     tell "env is the whole truth" from "the DB source degraded and may be hiding stored config".
 */
jest.mock('../lib/rest-auth', () => ({
  REST_API_BASE_URL: 'http://rest.test/v1',
  createRestAuthHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

import { isProviderEnabled } from '../lib/auth/provider-registry';
import {
  applyResolvedOverlay,
  invalidateProviderConfigCache,
  resolveProviderEnv,
  resolveProviderEnvWithSource,
} from '../lib/auth/provider-config-resolver';

const mockFetch = jest.fn<Promise<unknown>, unknown[]>();
(global as { fetch?: unknown }).fetch = mockFetch;

const TOKEN_ENV = { INTERNAL_SERVICE_TOKEN: 'svc-token' };

/** Build a 200 response whose JSON body is the given resolved payload. */
function okResponse(providers: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ providers }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidateProviderConfigCache();
  // The degrade-to-env paths log an operator warning by design; silence it so the suite output
  // stays clean (behaviour, not logging, is what these tests assert).
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetch gating & transport', () => {
  it('skips the fetch and returns base env when no service token is set', async () => {
    const base = { GITHUB_ID: 'env-id', GITHUB_SECRET: 'env-secret' };
    const result = await resolveProviderEnv(base, 1000);
    expect(result).toEqual(base);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('says once that a missing service token means admin config has no effect', async () => {
    // Running on env alone is legitimate, so this is not per-login noise — but it is also the
    // state where the admin screen silently does nothing, which needs to be visible somewhere.
    const base = { GITHUB_ID: 'env-id' };
    await resolveProviderEnv(base, 1000);
    await resolveProviderEnv(base, 2000);

    const notices = (console.warn as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes('INTERNAL_SERVICE_TOKEN is not set')
    );
    expect(notices).toHaveLength(1);
  });

  it('calls the resolved endpoint with the service-token header', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    await resolveProviderEnv({ ...TOKEN_ENV }, 1000);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://rest.test/v1/internal/auth-providers/resolved',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
        headers: expect.objectContaining({ 'X-Internal-Service-Token': 'svc-token' }),
      })
    );
  });
});

describe('DB-over-env parity matrix', () => {
  const BASE = {
    ...TOKEN_ENV,
    GITHUB_ID: 'env-gh-id',
    GITHUB_SECRET: 'env-gh-secret',
    GITLAB_CLIENT_ID: 'env-gl-id',
    GITLAB_CLIENT_SECRET: 'env-gl-secret',
    AZURE_AD_CLIENT_ID: 'env-az-id',
    AZURE_AD_CLIENT_SECRET: 'env-az-secret',
  };

  it('DB set: every provider uses DB creds over env', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: true, client_id: 'db-gh-id', client_secret: 'db-gh-secret', config: {} },
        gitlab: { enabled: true, client_id: 'db-gl-id', client_secret: 'db-gl-secret', config: {} },
        azure: { enabled: true, client_id: 'db-az-id', client_secret: 'db-az-secret', config: {} },
      })
    );
    const env = await resolveProviderEnv({ ...BASE }, 1000);
    expect(env.GITHUB_ID).toBe('db-gh-id');
    expect(env.GITHUB_SECRET).toBe('db-gh-secret');
    expect(env.GITLAB_CLIENT_ID).toBe('db-gl-id');
    expect(env.GITLAB_CLIENT_SECRET).toBe('db-gl-secret');
    expect(env.AZURE_AD_CLIENT_ID).toBe('db-az-id');
    expect(env.AZURE_AD_CLIENT_SECRET).toBe('db-az-secret');
  });

  it('DB partial: client_id from DB, secret falls back to env', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: 'db-gh-id', client_secret: null, config: {} },
      })
    );
    const env = await resolveProviderEnv({ ...BASE }, 1000);
    expect(env.GITHUB_ID).toBe('db-gh-id'); // DB
    expect(env.GITHUB_SECRET).toBe('env-gh-secret'); // fallback
  });

  it('DB absent: env values are used unchanged', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    const env = await resolveProviderEnv({ ...BASE }, 1000);
    expect(env.GITHUB_ID).toBe('env-gh-id');
    expect(env.GITHUB_SECRET).toBe('env-gh-secret');
    expect(env.GITLAB_CLIENT_ID).toBe('env-gl-id');
    expect(env.AZURE_AD_CLIENT_ID).toBe('env-az-id');
  });

  it('blank DB field ⇒ fallback (not disabled)', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: '   ', client_secret: '', config: {} },
      })
    );
    const env = await resolveProviderEnv({ ...BASE }, 1000);
    expect(env.GITHUB_ID).toBe('env-gh-id'); // blank DB → env kept
    expect(env.GITHUB_SECRET).toBe('env-gh-secret');
    expect(isProviderEnabled('github', env)).toBe(true); // still enabled via env
  });
});

describe('config extras & explicit enable toggle', () => {
  it('overlays env-var-keyed config extras (e.g. GITLAB_BASE_URL)', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        gitlab: {
          enabled: true,
          client_id: 'db-gl-id',
          client_secret: 'db-gl-secret',
          config: { GITLAB_BASE_URL: 'https://gitlab.example.com' },
        },
      })
    );
    const env = await resolveProviderEnv({ ...TOKEN_ENV }, 1000);
    expect(env.GITLAB_BASE_URL).toBe('https://gitlab.example.com');
  });

  it('enabled=false pins the provider off even when env sets its creds', async () => {
    const base = { ...TOKEN_ENV, GITHUB_ID: 'env-gh-id', GITHUB_SECRET: 'env-gh-secret' };
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: false, client_id: null, client_secret: null, config: {} },
      })
    );
    const env = await resolveProviderEnv(base, 1000);
    expect(env.GITHUB_ID).toBeUndefined();
    expect(env.GITHUB_SECRET).toBeUndefined();
    expect(isProviderEnabled('github', env)).toBe(false);
  });
});

describe('TTL cache', () => {
  const BASE = { ...TOKEN_ENV };

  it('serves from cache within the TTL (one fetch for two calls)', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    await resolveProviderEnv(BASE, 1_000);
    await resolveProviderEnv(BASE, 5_000); // within default 30s TTL
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches after the TTL expires', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    await resolveProviderEnv(BASE, 1_000);
    await resolveProviderEnv(BASE, 1_000 + 31_000); // past default 30s TTL
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('honors AUTH_PROVIDER_CONFIG_CACHE_TTL_MS, clamped to bounds', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    const env = { ...TOKEN_ENV, AUTH_PROVIDER_CONFIG_CACHE_TTL_MS: '1000' }; // below 5s floor
    await resolveProviderEnv(env, 1_000);
    await resolveProviderEnv(env, 1_000 + 4_000); // still within the 5s clamped floor
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('invalidateProviderConfigCache forces a re-fetch', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    await resolveProviderEnv(BASE, 1_000);
    invalidateProviderConfigCache();
    await resolveProviderEnv(BASE, 2_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('degrade to env, never throw', () => {
  const BASE = { ...TOKEN_ENV, GITHUB_ID: 'env-gh-id', GITHUB_SECRET: 'env-gh-secret' };

  it('non-200 response ⇒ env config', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const env = await resolveProviderEnv(BASE, 1_000);
    expect(env.GITHUB_ID).toBe('env-gh-id');
  });

  it('network error ⇒ env config', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const env = await resolveProviderEnv(BASE, 1_000);
    expect(env.GITHUB_ID).toBe('env-gh-id');
  });

  it('a failed fetch is cached briefly, then retried', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    await resolveProviderEnv(BASE, 1_000);
    await resolveProviderEnv(BASE, 3_000); // within 5s failure-cache window
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await resolveProviderEnv(BASE, 1_000 + 6_000); // past it
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('config source reporting (OLO-8.8, #4974)', () => {
  const BASE = { ...TOKEN_ENV, GITHUB_ID: 'env-gh-id', GITHUB_SECRET: 'env-gh-secret' };

  it('reports env-only when no service token switches the DB source on', async () => {
    // Legitimately env-only: nothing was lost, so boot validation may treat env as conclusive.
    const { env, source } = await resolveProviderEnvWithSource({ GITHUB_ID: 'env-id' }, 1_000);

    expect(source).toBe('env-only');
    expect(env.GITHUB_ID).toBe('env-id');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports db when the resolved endpoint answers, with the overlay applied', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: null, client_secret: 'db-gh-secret', config: {} },
      })
    );

    const { env, source } = await resolveProviderEnvWithSource(BASE, 1_000);

    expect(source).toBe('db');
    expect(env.GITHUB_SECRET).toBe('db-gh-secret');
  });

  it('reports unavailable — not env-only — for every failure to read a configured source', async () => {
    // The distinction boot validation depends on: config may be stored and simply unseen.
    const cases: Array<[string, () => void]> = [
      ['non-200', () => mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })],
      ['network error', () => mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))],
      [
        'malformed payload',
        () => mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
      ],
    ];

    for (const [name, arrange] of cases) {
      invalidateProviderConfigCache();
      mockFetch.mockReset();
      arrange();

      const { env, source } = await resolveProviderEnvWithSource(BASE, 1_000);

      expect([name, source]).toEqual([name, 'unavailable']);
      expect(env.GITHUB_ID).toBe('env-gh-id'); // degraded to env, never thrown
    }
  });

  it('warns about a malformed payload without echoing the body', async () => {
    // The body carries decrypted secrets, so only the shape of the failure may be logged.
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ providers: 'not-an-object' }),
    });

    await resolveProviderEnvWithSource(BASE, 1_000);

    const notices = (console.warn as jest.Mock).mock.calls.filter((call) =>
      String(call[0]).includes('unexpected payload shape')
    );
    expect(notices).toHaveLength(1);
    expect(String(notices[0][0])).not.toContain('not-an-object');
  });

  it('serves the source from cache alongside the value it belongs to', async () => {
    mockFetch.mockResolvedValue(okResponse({}));
    const first = await resolveProviderEnvWithSource(BASE, 1_000);
    const cached = await resolveProviderEnvWithSource(BASE, 5_000); // within the default TTL

    expect(first.source).toBe('db');
    expect(cached.source).toBe('db');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('resolveProviderEnv returns exactly the env half of the pair', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: 'db-gh-id', client_secret: null, config: {} },
      })
    );
    const withSource = await resolveProviderEnvWithSource(BASE, 1_000);
    const plain = await resolveProviderEnv(BASE, 2_000); // same cache window

    expect(plain).toEqual(withSource.env);
  });
});

describe('applyResolvedOverlay (pure)', () => {
  it('does not mutate the base env', () => {
    const base = { GITHUB_ID: 'env' };
    const out = applyResolvedOverlay(base, {
      providers: { github: { enabled: true, client_id: 'db', client_secret: 'x', config: {} } },
    });
    expect(base.GITHUB_ID).toBe('env'); // untouched
    expect(out.GITHUB_ID).toBe('db');
  });

  it('returns base env unchanged for a null payload', () => {
    const base = { GITHUB_ID: 'env' };
    expect(applyResolvedOverlay(base, null)).toEqual(base);
  });

  it('overlays a config-kind required field (an OIDC issuer) onto its env key (OLO-9.1)', () => {
    // An issuer-based provider stores its issuer in the env-var-keyed config JSONB; the overlay
    // lands it on the env var the auth stack reads — DB winning over env, a blank value falling
    // back to env. (Provider-specific client-id/secret env mapping is added per provider in
    // OLO-9.3+; the config overlay here is generic over any env-var-keyed extra.)
    const base = { OKTA_ISSUER: 'https://env.okta.com' };
    const out = applyResolvedOverlay(base, {
      providers: {
        okta: {
          enabled: true,
          client_id: 'db-id',
          client_secret: 'db-secret',
          config: { OKTA_ISSUER: 'https://db.okta.com', OKTA_BLANK: '   ' },
        },
      },
    });
    expect(out.OKTA_ISSUER).toBe('https://db.okta.com'); // DB config wins over env
    expect(out.OKTA_BLANK).toBeUndefined(); // blank ⇒ fallback, not stored
    expect(base.OKTA_ISSUER).toBe('https://env.okta.com'); // base untouched
  });
});
