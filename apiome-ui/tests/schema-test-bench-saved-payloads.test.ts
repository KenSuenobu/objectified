/**
 * Saved-payload store tests (IXH-5.3, #5115).
 *
 * The acceptance criterion is "payloads can be saved per schema and reloaded; saved payloads
 * are tenant-scoped". The scope IS the storage key, so these tests pin the key shape, the
 * cross-scope isolation, the newest-first ordering, the same-name replacement, the per-scope
 * cap, and the validating reader that drops unrecognized rows instead of crashing.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  deleteBenchPayload,
  isSavedBenchPayload,
  loadSavedBenchPayloads,
  MAX_SAVED_PAYLOADS_PER_SCHEMA,
  saveBenchPayload,
  savedBenchPayloadsStorageKey,
  type SavedBenchPayload,
} from '../src/app/utils/schema-test-bench-saved-payloads';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const REF = 'catalog/legacy-soap/latest/Order';

function payload(overrides: Partial<SavedBenchPayload> = {}): SavedBenchPayload {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    name: 'golden order',
    payloadText: '{"id": 1}',
    synthetic: false,
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('saved bench payloads', () => {
  it('keys storage by tenant AND schema reference', () => {
    expect(savedBenchPayloadsStorageKey(TENANT_A, REF)).toBe(
      `apiome:schema-test-bench:${TENANT_A}:${REF}`,
    );
  });

  it('saves and reloads a payload within its scope', () => {
    saveBenchPayload(TENANT_A, REF, payload({ name: 'one' }));
    const loaded = loadSavedBenchPayloads(TENANT_A, REF);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('one');
  });

  it('is tenant-scoped: another tenant sees nothing, even for the same schema', () => {
    saveBenchPayload(TENANT_A, REF, payload());
    expect(loadSavedBenchPayloads(TENANT_B, REF)).toEqual([]);
  });

  it('is schema-scoped: another schema of the same tenant sees nothing', () => {
    saveBenchPayload(TENANT_A, REF, payload());
    expect(loadSavedBenchPayloads(TENANT_A, 'project/petstore/latest/Pet')).toEqual([]);
  });

  it('orders newest first and replaces a same-name entry instead of duplicating it', () => {
    saveBenchPayload(TENANT_A, REF, payload({ name: 'a', savedAt: 1 }));
    saveBenchPayload(TENANT_A, REF, payload({ name: 'b', savedAt: 2 }));
    const replaced = saveBenchPayload(
      TENANT_A,
      REF,
      payload({ name: 'a', savedAt: 3, payloadText: '{"id": 2}' }),
    );
    expect(replaced.map((p) => p.name)).toEqual(['a', 'b']);
    expect(replaced[0].payloadText).toBe('{"id": 2}');
  });

  it('caps the list per scope, dropping the oldest', () => {
    for (let i = 0; i < MAX_SAVED_PAYLOADS_PER_SCHEMA + 5; i += 1) {
      saveBenchPayload(TENANT_A, REF, payload({ name: `p${i}`, savedAt: i }));
    }
    const loaded = loadSavedBenchPayloads(TENANT_A, REF);
    expect(loaded).toHaveLength(MAX_SAVED_PAYLOADS_PER_SCHEMA);
    expect(loaded[0].name).toBe(`p${MAX_SAVED_PAYLOADS_PER_SCHEMA + 4}`);
  });

  it('deletes by id and leaves the rest', () => {
    const keep = payload({ name: 'keep' });
    const drop = payload({ name: 'drop' });
    saveBenchPayload(TENANT_A, REF, keep);
    saveBenchPayload(TENANT_A, REF, drop);
    const after = deleteBenchPayload(TENANT_A, REF, drop.id);
    expect(after.map((p) => p.name)).toEqual(['keep']);
  });

  it('keeps the synthetic label across save/load', () => {
    saveBenchPayload(TENANT_A, REF, payload({ synthetic: true }));
    expect(loadSavedBenchPayloads(TENANT_A, REF)[0].synthetic).toBe(true);
  });

  it('drops rows it does not recognize instead of crashing on them', () => {
    window.localStorage.setItem(
      savedBenchPayloadsStorageKey(TENANT_A, REF),
      JSON.stringify([payload({ name: 'ok' }), { junk: true }, 'nope', null]),
    );
    const loaded = loadSavedBenchPayloads(TENANT_A, REF);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('ok');
    expect(isSavedBenchPayload({ junk: true })).toBe(false);
  });

  it('returns [] on corrupt storage', () => {
    window.localStorage.setItem(savedBenchPayloadsStorageKey(TENANT_A, REF), '{not json');
    expect(loadSavedBenchPayloads(TENANT_A, REF)).toEqual([]);
  });
});
