/**
 * exportVerifyCache — verify configuration keys + the per-session result cache (MFX-42.6, #4359).
 *
 * Covers the ticket's acceptance surface at the unit level:
 *  1. A key identifies a whole configuration (source fingerprint + target + options) and is
 *     insensitive to option *ordering*, so an unchanged config re-uses its cached verdict.
 *  2. Any real change produces a different key — which is what re-locks Generate upstream.
 *  3. The cache is bounded and expiring, and its reads never mutate it (they run during render).
 *  4. A verdict can be described in one line, so the UI can say which config it belongs to.
 */

import {
  createVerifyResultCache,
  describeVerifyConfig,
  sessionVerifyCache,
  verifyConfigKey,
  VERIFY_CACHE_LIMIT,
  VERIFY_CACHE_TTL_MS,
  __resetVerifyCacheForTests,
} from '../src/app/components/ade/dashboard/export/exportVerifyCache';

describe('verifyConfigKey — configuration identity (MFX-42.6)', () => {
  it('is null when there is nothing to verify', () => {
    expect(verifyConfigKey({ artifact: 'proj-1', target: null })).toBeNull();
    expect(verifyConfigKey({ artifact: '', target: 'proto' })).toBeNull();
  });

  it('ignores option key order — the same emit is one cache entry', () => {
    const a = verifyConfigKey({
      artifact: 'proj-1',
      target: 'proto',
      options: { package: 'com.example', emit_services: false },
    });
    const b = verifyConfigKey({
      artifact: 'proj-1',
      target: 'proto',
      options: { emit_services: false, package: 'com.example' },
    });
    expect(a).toBe(b);
  });

  it('ignores nested key order too', () => {
    const a = verifyConfigKey({
      artifact: 'proj-1',
      target: 'proto',
      options: { delivery: { branch: 'main', repo: 'acme/api' } },
    });
    const b = verifyConfigKey({
      artifact: 'proj-1',
      target: 'proto',
      options: { delivery: { repo: 'acme/api', branch: 'main' } },
    });
    expect(a).toBe(b);
  });

  it('treats "no overrides" and "an empty override map" as one configuration', () => {
    expect(verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: {} })).toBe(
      verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: null }),
    );
  });

  it('changes with the source, the version, the target, and any option value', () => {
    const base = verifyConfigKey({
      artifact: 'proj-1',
      version: 'rev-1',
      target: 'proto',
      options: { package: 'com.example' },
    });
    expect(verifyConfigKey({ artifact: 'proj-2', version: 'rev-1', target: 'proto', options: { package: 'com.example' } })).not.toBe(base);
    expect(verifyConfigKey({ artifact: 'proj-1', version: 'rev-2', target: 'proto', options: { package: 'com.example' } })).not.toBe(base);
    expect(verifyConfigKey({ artifact: 'proj-1', version: 'rev-1', target: 'openapi', options: { package: 'com.example' } })).not.toBe(base);
    expect(verifyConfigKey({ artifact: 'proj-1', version: 'rev-1', target: 'proto', options: { package: 'com.other' } })).not.toBe(base);
    // A latest-scoped config is not the same as an explicitly pinned revision.
    expect(verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: { package: 'com.example' } })).not.toBe(base);
  });

  it('distinguishes option values that stringify alike', () => {
    const asNull = verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: { package: null } });
    const asString = verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: { package: 'null' } });
    expect(asNull).not.toBe(asString);
  });

  it('keeps array order significant', () => {
    const a = verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: { tags: ['a', 'b'] } });
    const b = verifyConfigKey({ artifact: 'proj-1', target: 'proto', options: { tags: ['b', 'a'] } });
    expect(a).not.toBe(b);
  });
});

describe('describeVerifyConfig — which config a verdict belongs to (MFX-42.6)', () => {
  it('names the target and says so when nothing is overridden', () => {
    expect(describeVerifyConfig({ targetLabel: 'OpenAPI 3.1', options: null })).toBe(
      'OpenAPI 3.1 · default options',
    );
    expect(describeVerifyConfig({ targetLabel: 'OpenAPI 3.1', options: {} })).toBe(
      'OpenAPI 3.1 · default options',
    );
  });

  it('lists the overrides in a stable (alphabetical) order', () => {
    expect(
      describeVerifyConfig({
        targetLabel: 'gRPC / Protobuf',
        options: { package: 'com.example', emit_services: false },
      }),
    ).toBe('gRPC / Protobuf · emit_services = false, package = com.example');
  });

  it('summarises past the first three overrides', () => {
    expect(
      describeVerifyConfig({
        targetLabel: 'gRPC / Protobuf',
        options: { a: 1, b: 2, c: 3, d: 4, e: 5 },
      }),
    ).toBe('gRPC / Protobuf · a = 1, b = 2, c = 3, +2 more');
  });

  it('clips a long value rather than flooding the line', () => {
    const summary = describeVerifyConfig({
      targetLabel: 'gRPC / Protobuf',
      options: { package: 'com.example.a.very.long.package.name.indeed' },
    });
    expect(summary).toContain('…');
    expect(summary.length).toBeLessThan(60);
  });
});

describe('createVerifyResultCache — bounded, expiring, render-safe (MFX-42.6)', () => {
  it('stores and returns a value for its key', () => {
    const cache = createVerifyResultCache<string>();
    cache.set('k1', 'verdict-1');
    expect(cache.get('k1')).toBe('verdict-1');
    expect(cache.get('k2')).toBeNull();
    expect(cache.get(null)).toBeNull();
    expect(cache.size).toBe(1);
  });

  it('expires an entry once its TTL has elapsed', () => {
    const cache = createVerifyResultCache<string>(10, 1_000);
    cache.set('k1', 'verdict-1', 0);
    expect(cache.get('k1', 999)).toBe('verdict-1');
    expect(cache.get('k1', 1_000)).toBeNull();
  });

  it('reads do not mutate the cache (they run during render)', () => {
    const cache = createVerifyResultCache<string>(10, 1_000);
    cache.set('k1', 'verdict-1', 0);
    cache.get('k1', 5_000); // expired read
    expect(cache.size).toBe(1);
    // …and a later write prunes what the read left alone.
    cache.set('k2', 'verdict-2', 5_000);
    expect(cache.size).toBe(1);
    expect(cache.get('k2', 5_000)).toBe('verdict-2');
  });

  it('evicts the oldest entries beyond the limit', () => {
    const cache = createVerifyResultCache<string>(2);
    cache.set('k1', 'one');
    cache.set('k2', 'two');
    cache.set('k3', 'three');
    expect(cache.size).toBe(2);
    expect(cache.get('k1')).toBeNull();
    expect(cache.get('k2')).toBe('two');
    expect(cache.get('k3')).toBe('three');
  });

  it('re-storing a key makes it the newest entry', () => {
    const cache = createVerifyResultCache<string>(2);
    cache.set('k1', 'one');
    cache.set('k2', 'two');
    cache.set('k1', 'one-again');
    cache.set('k3', 'three');
    // k2 is now the oldest, so it is the one evicted — not the refreshed k1.
    expect(cache.get('k2')).toBeNull();
    expect(cache.get('k1')).toBe('one-again');
  });

  it('forgets one key on delete and everything on clear', () => {
    const cache = createVerifyResultCache<string>();
    cache.set('k1', 'one');
    cache.set('k2', 'two');
    cache.delete('k1');
    cache.delete(null);
    expect(cache.get('k1')).toBeNull();
    expect(cache.get('k2')).toBe('two');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('ships sane defaults', () => {
    expect(VERIFY_CACHE_LIMIT).toBeGreaterThan(0);
    expect(VERIFY_CACHE_TTL_MS).toBeGreaterThan(0);
  });
});

describe('sessionVerifyCache — the shared session store (MFX-42.6)', () => {
  afterEach(() => __resetVerifyCacheForTests());

  it('round-trips a verdict in the browser and is emptied by the test reset', () => {
    const key = verifyConfigKey({ artifact: 'proj-1', target: 'proto' });
    const verdict = { verdict: 'clean' } as unknown as Parameters<
      typeof sessionVerifyCache.set
    >[1];
    sessionVerifyCache.set(key as string, verdict);
    expect(sessionVerifyCache.get(key)).toBe(verdict);

    __resetVerifyCacheForTests();
    expect(sessionVerifyCache.get(key)).toBeNull();
  });
});
