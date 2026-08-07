/**
 * Unit tests for private-suite#2675: the import result names what it wrote and
 * what it skipped.
 * - `imported` carries one {id, name, created} ref per written class, in write
 *   order, so a caller can act on the classes (file them in a domain folder,
 *   add them to a working set) without re-reading the version.
 * - `skipped` carries one {name, reason} entry per selected class the import
 *   did not write, so a partial import can say which entries and why.
 * - `importedClasses` (names only) is unchanged for existing callers.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockCreateClass = jest.fn();
const mockAddPropertyToClass = jest.fn();
const mockUpdateClass = jest.fn();
const mockGetClassesForVersion = jest.fn();
const mockDeleteClassPropertiesForClass = jest.fn();

jest.mock('../../lib/db/helper', () => ({
  createClass: (...args: unknown[]) => mockCreateClass(...args),
  addPropertyToClass: (...args: unknown[]) => mockAddPropertyToClass(...args),
  updateClass: (...args: unknown[]) => mockUpdateClass(...args),
  getClassesForVersion: (...args: unknown[]) => mockGetClassesForVersion(...args),
  deleteClassPropertiesForClass: (...args: unknown[]) => mockDeleteClassPropertiesForClass(...args),
}));

const mockNormalize = jest.fn();
jest.mock('../../lib/importers', () => ({
  getImporter: jest.fn(() => ({
    normalize: (input: unknown) => mockNormalize(input),
  })),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(() => ({
    getAll: () => [],
  })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

// Must import after mocks
import { importClassesToVersion, type ImportClassesInput } from '../../lib/db/class-import-actions';

const DEFAULT_VERSION_ID = 'ver-1';
const DEFAULT_PROJECT_ID = 'proj-1';
const DEFAULT_DOCUMENT = { openapi: '3.0.0', info: { title: 'Test', version: '1.0.0' } };

function defaultInput(overrides: Partial<ImportClassesInput> = {}): ImportClassesInput {
  return {
    versionId: DEFAULT_VERSION_ID,
    projectId: DEFAULT_PROJECT_ID,
    document: DEFAULT_DOCUMENT,
    selectedSchemas: ['Customer', 'Invoice'],
    ...overrides,
  };
}

/** A normalized class with no properties, which needs no property library round trip. */
function normalizedClass(name: string) {
  return { name, description: null, schema: { type: 'object' }, properties: [] };
}

describe('private-suite#2675 imported refs and skip reasons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, property: { id: 'prop-1' } }),
    });
  });

  it('returns one created ref per new class, in write order', async () => {
    mockCreateClass
      .mockResolvedValueOnce(JSON.stringify({ success: true, class: { id: 'class-a' } }))
      .mockResolvedValueOnce(JSON.stringify({ success: true, class: { id: 'class-b' } }));
    mockNormalize.mockReturnValue({
      classes: [normalizedClass('Customer'), normalizedClass('Invoice')],
      warnings: [],
    });

    const result = await importClassesToVersion(defaultInput());

    expect(result.success).toBe(true);
    expect(result.imported).toEqual([
      { id: 'class-a', name: 'Customer', created: true },
      { id: 'class-b', name: 'Invoice', created: true },
    ]);
    expect(result.importedClasses).toEqual(['Customer', 'Invoice']);
    expect(result.skipped).toBeUndefined();
  });

  it('returns the existing id with created:false for an overwritten class', async () => {
    mockGetClassesForVersion.mockResolvedValue(
      JSON.stringify([{ id: 'existing-class-id', name: 'Customer' }])
    );
    mockUpdateClass.mockResolvedValue(
      JSON.stringify({ success: true, class: { id: 'existing-class-id' } })
    );
    mockCreateClass.mockResolvedValue(
      JSON.stringify({ success: true, class: { id: 'new-class-id' } })
    );
    mockNormalize.mockReturnValue({
      classes: [normalizedClass('Customer'), normalizedClass('Invoice')],
      warnings: [],
    });

    const result = await importClassesToVersion(defaultInput({ overwriteExisting: true }));

    expect(result.success).toBe(true);
    expect(result.imported).toEqual([
      { id: 'existing-class-id', name: 'Customer', created: false },
      { id: 'new-class-id', name: 'Invoice', created: true },
    ]);
  });

  it('names a skipped duplicate and says why', async () => {
    mockCreateClass
      .mockResolvedValueOnce(JSON.stringify({ success: false, error: 'Class already exists' }))
      .mockResolvedValueOnce(JSON.stringify({ success: true, class: { id: 'class-b' } }));
    mockNormalize.mockReturnValue({
      classes: [normalizedClass('Customer'), normalizedClass('Invoice')],
      warnings: [],
    });

    const result = await importClassesToVersion(defaultInput());

    expect(result.success).toBe(true);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toEqual([
      { name: 'Customer', reason: 'a class with this name already exists in this version' },
    ]);
    expect(result.imported).toEqual([{ id: 'class-b', name: 'Invoice', created: true }]);
    expect(result.importedClasses).toEqual(['Invoice']);
  });
});
