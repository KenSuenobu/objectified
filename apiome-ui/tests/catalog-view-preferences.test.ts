/**
 * Unit tests for the Catalog persisted view preferences (MFI-28.4, #4120).
 *
 * Covers the pure parse/serialize/coerce helpers (validation, self-healing of a corrupt blob,
 * per-field defaulting) and the localStorage round-trip (load/persist), including the SSR-safe and
 * non-throwing guarantees. These are the contract the toolbar relies on to restore a reload's
 * view/group/sort/show-deleted choices without ever surfacing an impossible state.
 */

import {
  CATALOG_VIEW_PREFS_STORAGE_KEY,
  DEFAULT_CATALOG_VIEW_PREFERENCES,
  coerceCatalogViewPreferences,
  parseCatalogViewPreferences,
  serializeCatalogViewPreferences,
  loadCatalogViewPreferences,
  persistCatalogViewPreferences,
  type CatalogViewPreferences,
} from '../src/app/utils/catalog-view-preferences';

const NON_DEFAULT: CatalogViewPreferences = {
  viewMode: 'table',
  groupMode: 'none',
  sortColumn: 'quality',
  sortDirection: 'desc',
  showDeleted: true,
};

describe('defaults', () => {
  it('defaults to cards / protocol / name-asc / hidden-deleted', () => {
    expect(DEFAULT_CATALOG_VIEW_PREFERENCES).toEqual({
      viewMode: 'cards',
      groupMode: 'protocol',
      sortColumn: 'name',
      sortDirection: 'asc',
      showDeleted: false,
    });
  });
});

describe('coerceCatalogViewPreferences', () => {
  it('passes a fully-valid object through unchanged', () => {
    expect(coerceCatalogViewPreferences(NON_DEFAULT)).toEqual(NON_DEFAULT);
  });

  it('fills every field from defaults when given a non-object', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      expect(coerceCatalogViewPreferences(bad)).toEqual(DEFAULT_CATALOG_VIEW_PREFERENCES);
    }
  });

  it('replaces an invalid field with its default but keeps the valid siblings', () => {
    const coerced = coerceCatalogViewPreferences({
      viewMode: 'holographic', // invalid → default 'cards'
      groupMode: 'none', // valid
      sortColumn: 'creator', // sorter knows it, but the screen cannot select it → default 'name'
      sortDirection: 'sideways', // invalid → default 'asc'
      showDeleted: 'yes', // wrong type → default false
    });
    expect(coerced).toEqual({
      viewMode: 'cards',
      groupMode: 'none',
      sortColumn: 'name',
      sortDirection: 'asc',
      showDeleted: false,
    });
  });

  it('keeps the header-only sort columns, which the table headers can select', () => {
    // Protocol / Source / Status have no toolbar chip but are clickable column headers, so a
    // choice made there has to survive a reload like any other.
    for (const sortColumn of ['protocol', 'source', 'status'] as const) {
      expect(coerceCatalogViewPreferences({ ...NON_DEFAULT, sortColumn }).sortColumn).toBe(sortColumn);
    }
  });

  it('preserves a false showDeleted rather than treating it as missing', () => {
    expect(coerceCatalogViewPreferences({ ...NON_DEFAULT, showDeleted: false }).showDeleted).toBe(false);
  });
});

describe('parse / serialize round-trip', () => {
  it('round-trips a preferences object losslessly', () => {
    const raw = serializeCatalogViewPreferences(NON_DEFAULT);
    expect(parseCatalogViewPreferences(raw)).toEqual(NON_DEFAULT);
  });

  it('returns defaults for null / empty / malformed JSON', () => {
    for (const raw of [null, undefined, '', '{not json', '[1,2,3']) {
      expect(parseCatalogViewPreferences(raw as string | null)).toEqual(DEFAULT_CATALOG_VIEW_PREFERENCES);
    }
  });
});

describe('localStorage load / persist', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns defaults when nothing is stored', () => {
    expect(loadCatalogViewPreferences()).toEqual(DEFAULT_CATALOG_VIEW_PREFERENCES);
  });

  it('persists and reloads the exact preferences', () => {
    persistCatalogViewPreferences(NON_DEFAULT);
    expect(window.localStorage.getItem(CATALOG_VIEW_PREFS_STORAGE_KEY)).toBe(
      serializeCatalogViewPreferences(NON_DEFAULT),
    );
    expect(loadCatalogViewPreferences()).toEqual(NON_DEFAULT);
  });

  it('self-heals a corrupt stored blob to defaults on load', () => {
    window.localStorage.setItem(CATALOG_VIEW_PREFS_STORAGE_KEY, '{"viewMode":"bogus"');
    expect(loadCatalogViewPreferences()).toEqual(DEFAULT_CATALOG_VIEW_PREFERENCES);
  });

  it('does not throw when localStorage.setItem fails (quota / private mode)', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => persistCatalogViewPreferences(NON_DEFAULT)).not.toThrow();
    spy.mockRestore();
  });

  it('does not throw when localStorage.getItem fails', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(loadCatalogViewPreferences()).toEqual(DEFAULT_CATALOG_VIEW_PREFERENCES);
    spy.mockRestore();
  });
});
