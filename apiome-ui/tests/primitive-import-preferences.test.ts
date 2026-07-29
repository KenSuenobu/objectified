/**
 * Standing preferences for the Primitives import wizard.
 *
 * Covers the defaults, the round-trip, and the degradation paths — unreadable or corrupt storage
 * must fall back to defaults rather than throwing inside the wizard's render.
 */

import {
  DEFAULT_PRIMITIVE_IMPORT_PREFERENCES,
  persistPrimitiveImportPreferences,
  readPrimitiveImportPreferences,
} from '../src/app/utils/primitive-import-preferences';

const STORAGE_KEY = 'apiome.primitive-import.v1';

beforeEach(() => {
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe('primitive import preferences', () => {
  it('defaults auto-extraction off, so nothing changes until it is asked for', () => {
    expect(DEFAULT_PRIMITIVE_IMPORT_PREFERENCES.autoExtractNamespace).toBe(false);
    expect(readPrimitiveImportPreferences()).toEqual({ autoExtractNamespace: false });
  });

  it('round-trips the preference', () => {
    persistPrimitiveImportPreferences({ autoExtractNamespace: true });
    expect(readPrimitiveImportPreferences().autoExtractNamespace).toBe(true);

    persistPrimitiveImportPreferences({ autoExtractNamespace: false });
    expect(readPrimitiveImportPreferences().autoExtractNamespace).toBe(false);
  });

  it('ignores a stored value of the wrong type', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ autoExtractNamespace: 'yes' }));
    expect(readPrimitiveImportPreferences().autoExtractNamespace).toBe(false);
  });

  it('falls back to defaults on corrupt JSON rather than throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(readPrimitiveImportPreferences()).toEqual({ autoExtractNamespace: false });
  });

  it('treats a storage write failure (quota / private mode) as a no-op', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => persistPrimitiveImportPreferences({ autoExtractNamespace: true })).not.toThrow();
  });
});
