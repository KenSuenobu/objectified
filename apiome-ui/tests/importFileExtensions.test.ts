/**
 * Unit tests for the registry-derived file-picker accept list (FMT-1.1, #5412).
 *
 * Both importers used to hard-code a ten-entry `accept` array while the engine registered 43
 * adapters, so `.tsp`, `.cpy`, `.edi`, `.hl7` and thirty more working formats could not even be
 * browsed to. These tests pin the replacement contract:
 *
 *  - the accept list is derived from `GET /api/import/sources`, so registering an adapter widens it
 *    with no UI change;
 *  - the ten-entry array survives only as an offline fallback;
 *  - `isAcceptedImportFile` is advisory — an unknown extension is a warning, never a rejection.
 */

import {
  FALLBACK_IMPORT_FILE_EXTENSIONS,
  mergeImportFileExtensions,
  type ImportSourceDescriptor,
} from '../src/app/components/ade/dashboard/importSourceCatalog';
import {
  IMPORT_FILE_EXTENSIONS,
  describeImportExtensions,
  isAcceptedImportFile,
} from '../src/app/components/ade/import/importWizardModel';

/** A descriptor as `GET /api/import/sources` advertises it, with only the fields under test set. */
function descriptor(
  key: string,
  file_extensions: string[],
  overrides: Partial<ImportSourceDescriptor> = {},
): ImportSourceDescriptor {
  return {
    key,
    label: key,
    description: `The ${key} adapter.`,
    icon: 'file-code',
    paradigm: 'rest',
    input_kinds: ['file', 'url', 'paste'],
    supports_live_discovery: false,
    formats: [key],
    file_extensions,
    ...overrides,
  };
}

/** The three adapters the ticket named as unreachable, as the registry reports them. */
const TYPESPEC = descriptor('typespec', ['.tsp', '.cadl']);
const COPYBOOK = descriptor('cobolcopybook', ['.cpy', '.cbl', '.copybook']);
const EDI = descriptor('edix12', ['.edi', '.x12']);
const OPENAPI = descriptor('openapi', ['.yaml', '.yml', '.json', '.zip']);

// ===========================================================================
// Deriving the accept list from the registry
// ===========================================================================

describe('mergeImportFileExtensions', () => {
  it('unions every adapter’s declared extensions', () => {
    const merged = mergeImportFileExtensions([TYPESPEC, COPYBOOK, EDI]);
    expect(merged).toEqual(['.tsp', '.cadl', '.cpy', '.cbl', '.copybook', '.edi', '.x12']);
  });

  it('preserves first-seen order so each adapter’s canonical extension leads', () => {
    const merged = mergeImportFileExtensions([TYPESPEC, OPENAPI]);
    expect(merged[0]).toBe('.tsp');
    expect(merged.indexOf('.yaml')).toBeLessThan(merged.indexOf('.json'));
  });

  it('de-duplicates an extension several adapters claim', () => {
    const jsonSchema = descriptor('json-schema', ['.schema.json', '.json']);
    const merged = mergeImportFileExtensions([OPENAPI, jsonSchema]);
    expect(merged.filter((ext) => ext === '.json')).toHaveLength(1);
    expect(merged).toContain('.schema.json');
  });

  it('normalizes case, whitespace and a missing leading dot', () => {
    const messy = descriptor('messy', ['  .TSP ', 'cadl', '']);
    expect(mergeImportFileExtensions([messy])).toEqual(['.tsp', '.cadl']);
  });

  it('keeps an unavailable adapter’s extensions selectable', () => {
    // Hiding `.proto` because this runtime lacks `buf` would turn a fixable toolchain message into
    // a file the user simply cannot pick — a worse failure than the one it avoids.
    const grpc = descriptor('grpc', ['.proto'], {
      available: false,
      unavailable_reason: 'Requires the buf toolchain.',
    });
    expect(mergeImportFileExtensions([grpc])).toContain('.proto');
  });

  it('ignores adapters that declare nothing, such as the paste-only sample', () => {
    const sample = descriptor('sample', [], { input_kinds: ['paste'] });
    expect(mergeImportFileExtensions([sample, TYPESPEC])).toEqual(['.tsp', '.cadl']);
  });

  it('tolerates a malformed payload without collapsing the picker', () => {
    const broken = { key: 'broken', file_extensions: [null, 42, '.ok'] } as unknown as ImportSourceDescriptor;
    expect(mergeImportFileExtensions([broken])).toEqual(['.ok']);
  });

  it('falls back to the offline list when the registry is unreachable', () => {
    expect(mergeImportFileExtensions(null)).toEqual([...FALLBACK_IMPORT_FILE_EXTENSIONS]);
    expect(mergeImportFileExtensions(undefined)).toEqual([...FALLBACK_IMPORT_FILE_EXTENSIONS]);
    expect(mergeImportFileExtensions([])).toEqual([...FALLBACK_IMPORT_FILE_EXTENSIONS]);
  });

  it('returns a fresh array the caller cannot use to mutate the fallback', () => {
    const merged = mergeImportFileExtensions(null);
    merged.push('.injected');
    expect(FALLBACK_IMPORT_FILE_EXTENSIONS).not.toContain('.injected');
  });
});

// ===========================================================================
// The acceptance criterion: registering an adapter widens the accept list
// ===========================================================================

describe('registering a new adapter', () => {
  /** The registry payload before and after a fixture adapter is registered server-side. */
  const before = [OPENAPI, TYPESPEC];
  const after = [...before, descriptor('exotic', ['.exotic', '.xtc'])];

  it('changes the accept list with no UI code change', () => {
    const acceptBefore = mergeImportFileExtensions(before).join(',');
    const acceptAfter = mergeImportFileExtensions(after).join(',');

    expect(acceptBefore).not.toContain('.exotic');
    expect(acceptAfter).toContain('.exotic');
    expect(acceptAfter).toContain('.xtc');
    expect(acceptAfter).not.toEqual(acceptBefore);
    // Nothing that was offered before is dropped.
    for (const ext of mergeImportFileExtensions(before)) {
      expect(mergeImportFileExtensions(after)).toContain(ext);
    }
  });

  it('makes the new adapter’s files advisory-recognized too', () => {
    expect(isAcceptedImportFile('thing.exotic', mergeImportFileExtensions(before))).toBe(false);
    expect(isAcceptedImportFile('thing.exotic', mergeImportFileExtensions(after))).toBe(true);
  });
});

// ===========================================================================
// isAcceptedImportFile is advisory
// ===========================================================================

describe('isAcceptedImportFile', () => {
  const registry = mergeImportFileExtensions([TYPESPEC, COPYBOOK, EDI, OPENAPI]);

  it.each(['api.tsp', 'CUSTOMER.CPY', 'claims.edi', 'spec.YAML'])(
    'recognizes %s against the registry list',
    (name) => {
      expect(isAcceptedImportFile(name, registry)).toBe(true);
    },
  );

  it('honours a compound extension rather than only its last segment', () => {
    const postman = mergeImportFileExtensions([descriptor('postman', ['.postman_collection.json'])]);
    expect(isAcceptedImportFile('team.postman_collection.json', postman)).toBe(true);
    // `.json` alone is not declared by that adapter, so a plain .json is not recognized by it.
    expect(isAcceptedImportFile('team.json', postman)).toBe(false);
  });

  it('reports an unknown extension as unrecognized without implying rejection', () => {
    // The dialog turns this `false` into an advisory notice and still sends the bytes to
    // POST /v1/import/detect — content sniffing is the authority, not the filename.
    expect(isAcceptedImportFile('mystery.bin', registry)).toBe(false);
    expect(isAcceptedImportFile('no-extension-at-all', registry)).toBe(false);
  });

  it('defaults to the offline fallback list when no accept list is supplied', () => {
    expect(isAcceptedImportFile('spec.yaml')).toBe(true);
    expect(isAcceptedImportFile('api.tsp')).toBe(false);
  });

  it('keeps the ten-entry array only as the offline fallback', () => {
    expect(IMPORT_FILE_EXTENSIONS).toEqual(FALLBACK_IMPORT_FILE_EXTENSIONS);
    expect(IMPORT_FILE_EXTENSIONS).toHaveLength(10);
  });
});

// ===========================================================================
// The drop-zone hint
// ===========================================================================

describe('describeImportExtensions', () => {
  it('names the leading extensions and elides the long tail', () => {
    const many = Array.from({ length: 14 }, (_, i) => `.e${i}`);
    expect(describeImportExtensions(many)).toBe(
      'Supports: .e0, .e1, .e2, .e3, .e4, .e5, .e6, .e7, .e8, .e9 and 4 more',
    );
  });

  it('omits the tail when everything fits', () => {
    expect(describeImportExtensions(['.tsp', '.cpy'])).toBe('Supports: .tsp, .cpy');
  });

  it('honours a caller-supplied limit', () => {
    expect(describeImportExtensions(['.a', '.b', '.c'], 2)).toBe('Supports: .a, .b and 1 more');
  });

  it('degrades to the bare prefix rather than rendering a dangling colon list', () => {
    expect(describeImportExtensions([])).toBe('Supports:');
  });
});
