/**
 * @jest-environment node
 *
 * Boot-time provider validation (OLO-7.2; Better-Auth-only guardrail from OLO-10.9, #5004).
 *
 * OLO-7.2 fails a partially-configured sign-in provider loud at startup (or, in `warn` mode, logs and
 * leaves it disabled) via the Next.js `register()` hook in `src/instrumentation.ts`. That hook is
 * gated only on the Node.js runtime, and validates env against the shared `PROVIDER_REGISTRY` the
 * Better Auth provider set is built from.
 *
 * These tests drive the real boot hook and pin that strict aborts, warn degrades, a coherent env boots
 * clean, and the edge runtime skips validation. `validateProviderEnv` reads the live `process.env` (the
 * boot hook has no injectable env), so each test scrubs every provider env var first to isolate the case.
 */

import { PROVIDER_REGISTRY } from '../lib/auth/provider-registry';

/** Every required provider env var across the registry — the keys a boot case must control. */
const PROVIDER_ENV_KEYS = Array.from(
  new Set(PROVIDER_REGISTRY.flatMap((provider) => [...provider.requiredEnvKeys]))
);

/** Provider keys plus the switches the boot hook and validation mode read. */
const CONTROLLED_KEYS = [...PROVIDER_ENV_KEYS, 'AUTH_PROVIDER_VALIDATION', 'NEXT_RUNTIME'];

describe('OLO-7.2 boot validation (OLO-10.9)', () => {
  const saved: Record<string, string | undefined> = {};

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
  });

  afterEach(() => {
    for (const key of CONTROLLED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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
    expect(console.warn).toHaveBeenCalled();
  });

  test('a coherent env boots cleanly — no throw, no warning', async () => {
    // github fully set, every other provider fully unset ⇒ both are valid deployments.
    process.env.GITHUB_ID = 'gh-id';
    process.env.GITHUB_SECRET = 'gh-secret';

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('the hook is skipped off the Node.js runtime (no validation on the edge)', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    process.env.GITHUB_ID = 'gh-id'; // partial, but the edge runtime must not validate

    const { register } = await import('../src/instrumentation');

    await expect(register()).resolves.toBeUndefined();
  });
});
