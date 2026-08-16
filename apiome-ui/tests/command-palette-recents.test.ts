/**
 * The command palette's Recent group, stored locally (HIVE-3.6, #5292).
 *
 * Two rules to pin, both of which are about what the reader must *not* see: a project from
 * another workspace, and a broken palette on a browser that refuses storage. The rest of
 * the module — the cap, the newest-first order, the idempotent re-record — is the ordinary
 * behaviour of a most-recently-used list, and each is one assertion here.
 */

import {
  PALETTE_RECENTS_LIMIT,
  PALETTE_RECENTS_STORAGE_KEY,
  clearCommandPaletteRecents,
  readCommandPaletteRecents,
  recordCommandPaletteRecent,
} from '../src/app/components/shell/commandPaletteRecents';

/** A destination worth remembering. */
const ENTRY = {
  id: 'proj-1',
  label: 'Payments API',
  href: '/ade/dashboard/projects/1',
  meta: 'v2.4.0 · draft',
  icon: 'file-json-2',
};

beforeEach(() => {
  window.localStorage.clear();
});

describe('per workspace', () => {
  it('never shows one workspace’s history in another', () => {
    recordCommandPaletteRecent('t-1', ENTRY);
    recordCommandPaletteRecent('t-2', { ...ENTRY, id: 'proj-9', label: 'Shipping API' });

    expect(readCommandPaletteRecents('t-1').map((row) => row.label)).toEqual(['Payments API']);
    expect(readCommandPaletteRecents('t-2').map((row) => row.label)).toEqual(['Shipping API']);
  });

  it('has nothing to offer, and records nothing, with no workspace', () => {
    expect(recordCommandPaletteRecent(null, ENTRY)).toEqual([]);
    expect(readCommandPaletteRecents(null)).toEqual([]);
    expect(readCommandPaletteRecents(undefined)).toEqual([]);
    // Nothing was written: an entry with no workspace could never be shown again.
    expect(window.localStorage.getItem(PALETTE_RECENTS_STORAGE_KEY)).toBeNull();
  });
});

describe('the list itself', () => {
  it('puts the newest first', () => {
    recordCommandPaletteRecent('t-1', { ...ENTRY, id: 'a', label: 'First', at: 1 });
    recordCommandPaletteRecent('t-1', { ...ENTRY, id: 'b', label: 'Second', at: 2 });

    expect(readCommandPaletteRecents('t-1').map((row) => row.label)).toEqual(['Second', 'First']);
  });

  it('moves a re-opened destination back to the top instead of listing it twice', () => {
    recordCommandPaletteRecent('t-1', { ...ENTRY, id: 'a', label: 'First', at: 1 });
    recordCommandPaletteRecent('t-1', { ...ENTRY, id: 'b', label: 'Second', at: 2 });
    const after = recordCommandPaletteRecent('t-1', {
      ...ENTRY,
      id: 'a',
      label: 'First, renamed',
      at: 3,
    });

    expect(after.map((row) => row.label)).toEqual(['First, renamed', 'Second']);
    expect(after).toHaveLength(2);
  });

  it('keeps only the last few, so Recent cannot push the other groups off screen', () => {
    for (let index = 0; index < PALETTE_RECENTS_LIMIT + 3; index += 1) {
      recordCommandPaletteRecent('t-1', {
        ...ENTRY,
        id: `p-${index}`,
        label: `Project ${index}`,
        at: index,
      });
    }

    const rows = readCommandPaletteRecents('t-1');
    expect(rows).toHaveLength(PALETTE_RECENTS_LIMIT);
    expect(rows[0].label).toBe(`Project ${PALETTE_RECENTS_LIMIT + 2}`);
  });

  it('stamps the time itself when the caller does not', () => {
    const before = Date.now();
    const [row] = recordCommandPaletteRecent('t-1', ENTRY);

    expect(row.at).toBeGreaterThanOrEqual(before);
  });

  it('forgets one workspace, or all of them', () => {
    recordCommandPaletteRecent('t-1', ENTRY);
    recordCommandPaletteRecent('t-2', { ...ENTRY, id: 'proj-9' });

    clearCommandPaletteRecents('t-1');
    expect(readCommandPaletteRecents('t-1')).toEqual([]);
    expect(readCommandPaletteRecents('t-2')).toHaveLength(1);

    clearCommandPaletteRecents();
    expect(readCommandPaletteRecents('t-2')).toEqual([]);
  });
});

describe('a store that cannot be trusted', () => {
  it.each([
    ['not JSON at all', 'nonsense{'],
    ['a list where a map belongs', '[1, 2, 3]'],
    ['a workspace whose value is not a list', '{"t-1": 7}'],
  ])('reads %s as an empty history rather than throwing', (_label, raw) => {
    window.localStorage.setItem(PALETTE_RECENTS_STORAGE_KEY, raw);

    expect(readCommandPaletteRecents('t-1')).toEqual([]);
  });

  it('drops a row that could not be drawn, and keeps the rest', () => {
    window.localStorage.setItem(
      PALETTE_RECENTS_STORAGE_KEY,
      JSON.stringify({
        't-1': [
          { id: 'ok', label: 'Kept', href: '/x', at: 2 },
          { id: 'no-href', label: 'Dropped', at: 1 },
          { id: 'no-label', href: '/y', at: 1 },
          'not an object',
        ],
      })
    );

    expect(readCommandPaletteRecents('t-1').map((row) => row.id)).toEqual(['ok']);
  });

  it('carries on when the browser refuses to store anything', () => {
    const setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    try {
      // The write is swallowed; the palette simply has no Recent group.
      expect(() => recordCommandPaletteRecent('t-1', ENTRY)).not.toThrow();
      expect(readCommandPaletteRecents('t-1')).toEqual([]);
    } finally {
      setItem.mockRestore();
    }
  });

  it('carries on when the browser refuses to be read', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    try {
      expect(readCommandPaletteRecents('t-1')).toEqual([]);
    } finally {
      getItem.mockRestore();
    }
  });
});
