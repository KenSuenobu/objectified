/**
 * @jest-environment node
 *
 * Boot-time provider validation (OLO-7.2; Better-Auth-only guardrail from OLO-10.9, #5004;
 * DB-source awareness from OLO-8.8, #4974).
 *
 * OLO-7.2 fails a partially-configured sign-in provider loud at startup (or, in `warn` mode, logs and
 * leaves it disabled) via the Next.js `register()` hook in `src/instrumentation.ts`. That hook is
 * gated only on the Node.js runtime, and validates config against the shared `PROVIDER_REGISTRY` the
 * Better Auth provider set is built from.
 *
 * Since OLO-8.5 that config is **DB-first with `.env` fallback**, so the hook validates the merged
 * overlay rather than raw `process.env`. These tests drive the real boot hook end to end and pin:
 * strict aborts, warn degrades, a coherent env boots clean, the edge runtime skips validation, a
 * provider completed from the database is never flagged as "missing env", and an unreadable DB
 * source downgrades strict instead of turning a REST outage into a boot outage.
 *
 * `register()` has no injectable env, so each test scrubs every provider env var (plus the resolver's
 * service token) first to isolate the case, and stubs `fetch` for the DB-sourced cases.
 */

import { PROVIDER_REGISTRY } from '../lib/auth/provider-registry';

/** Every required provider env var across the registry — the keys a boot case must control. */
const PROVIDER_ENV_KEYS = Array.from(
  new Set(PROVIDER_REGISTRY.flatMap((provider) => [...provider.requiredEnvKeys]))
);

/**
 * Provider keys plus the switches the boot hook, validation mode, and DB-over-env resolver read.
 * `INTERNAL_SERVICE_TOKEN` decides whether the DB source is consulted at all, so it belongs to the
 * controlled set: leaving a developer's real token in scope would make these cases hit the network.
 */
const CONTROLLED_KEYS = [
  ...PROVIDER_ENV_KEYS,
  'AUTH_PROVIDER_VALIDATION',
  'NEXT_RUNTIME',
  'INTERNAL_SERVICE_TOKEN',
];

/** Every message passed to `console.warn` during a boot, in order. */
const warnings = (): string[] =>
  (console.warn as jest.Mock).mock.calls.map((call) => String(call[0]));

/** The subset of warnings reporting a partially-configured provider. */
const partialConfigWarnings = (): string[] =>
  warnings().filter((message) => message.includes('is partially configured'));

/** Build a 200 resolved-endpoint response carrying the given per-provider config. */
function okResponse(providers: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ providers }) };
}

describe('OLO-7.2 boot validation (OLO-10.9)', () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    for (const key of CONTROLLED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // The boot hook only runs on the Node.js runtime.
    process.env.NEXT_RUNTIME = 'nodejs';
    jest.resetModules();
    // warn mode logs by design; silence it so the suite stays clean while still asserting the call.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Unstubbed by default: with no service token the resolver never fetches, so any call here
    // would be a bug rather than a test fixture.
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const key of CONTROLLED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('strict mode aborts startup on partial provider config', async () => {
    // github id set, secret missing ⇒ partial config ⇒ strict (default) must refuse to start.
    process.env.GITHUB_ID = 'gh-id';
    const { register } = await import('../src/instrumentation');

    await expect(register()).rejects.toThrow(/Refusing to start/);
  });

  test('warn mode logs and does not throw', async () => {
    process.env.AUTH_PROVIDER_VALIDATION = 'warn';
    process.env.GITLAB_CLIENT_ID = 'gl-id'; // secret missing ⇒ partial

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toHaveLength(1);
  });

  test('a coherent env boots cleanly — no throw, no provider-config warning', async () => {
    // github fully set, every other provider fully unset ⇒ both are valid deployments.
    process.env.GITHUB_ID = 'gh-id';
    process.env.GITHUB_SECRET = 'gh-secret';

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('the hook is skipped off the Node.js runtime (no validation on the edge)', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    process.env.GITHUB_ID = 'gh-id'; // partial, but the edge runtime must not validate

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
  });

  test('running without the DB source says so once, at boot (OLO-8.8)', async () => {
    // The env-only deployment is legitimate, but it is also the state in which the admin screen
    // silently does nothing — boot is the right place for that to be visible exactly once.
    process.env.GITHUB_ID = 'gh-id';
    process.env.GITHUB_SECRET = 'gh-secret';

    const { register } = await import('../src/instrumentation');
    await register();

    expect(
      warnings().filter((message) => message.includes('INTERNAL_SERVICE_TOKEN is not set'))
    ).toHaveLength(1);
  });
});

describe('OLO-8.8 boot validation against DB-sourced config', () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    for (const key of CONTROLLED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NEXT_RUNTIME = 'nodejs';
    // A service token is what switches the DB source on; without it the resolver never fetches.
    process.env.INTERNAL_SERVICE_TOKEN = 'svc-token';
    jest.resetModules();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    for (const key of CONTROLLED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('a provider completed from the database is not flagged as missing env', async () => {
    // The acceptance criterion: env holds only the client id, the DB holds the secret. Pre-8.8 this
    // read as partial config and refused to start.
    process.env.GITHUB_ID = 'gh-id';
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: null, client_secret: 'db-gh-secret', config: {} },
      })
    );

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a provider configured entirely in the database boots clean with no env vars at all', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        gitlab: {
          enabled: true,
          client_id: 'db-gl-id',
          client_secret: 'db-gl-secret',
          config: {},
        },
      })
    );

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toEqual([]);
  });

  test('a provider pinned off in the database is not flagged even when env is partial', async () => {
    // `enabled: false` strips the provider's credential keys from the overlay, so "some env vars
    // set" resolves to "nothing set" — cleanly disabled, not misconfigured.
    process.env.GITHUB_ID = 'gh-id';
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: false, client_id: null, client_secret: null, config: {} },
      })
    );

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toEqual([]);
  });

  test('config still partial after the merge fails strict startup, naming the admin screen', async () => {
    // The DB row exists but only carries the client id, and env has nothing — genuinely partial.
    mockFetch.mockResolvedValue(
      okResponse({
        github: { enabled: null, client_id: 'db-gh-id', client_secret: null, config: {} },
      })
    );

    const { register } = await import('../src/instrumentation');

    await expect(register()).rejects.toThrow(/Refusing to start/);
    await expect(register()).rejects.toThrow(/Admin → System Configuration/);
  });

  test('an unreadable DB source downgrades strict to a warning instead of aborting', async () => {
    // REST is down (a common startup ordering in compose). GITHUB_SECRET may well be in the DB —
    // this view simply cannot see it, so refusing to start would fail on unproven evidence.
    process.env.GITHUB_ID = 'gh-id';
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(partialConfigWarnings()).toHaveLength(1);
    expect(partialConfigWarnings()[0]).toContain('may already be fully configured in the database');
    expect(
      warnings().filter((message) => message.includes('AUTH_PROVIDER_VALIDATION=strict not enforced'))
    ).toHaveLength(1);
  });

  test('an unreadable DB source still aborts on an invalid validation mode', async () => {
    // The downgrade covers unproven partial config only; a typo'd mode is unambiguous either way.
    process.env.AUTH_PROVIDER_VALIDATION = 'off';
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const { register } = await import('../src/instrumentation');

    await expect(register()).rejects.toThrow(/not a valid validation mode/);
  });
});
