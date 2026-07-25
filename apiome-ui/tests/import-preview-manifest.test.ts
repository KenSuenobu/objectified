/**
 * import-preview-manifest utils — the preview panel's data layer (IXH-3.2, #5104).
 *
 * Pins the pure pieces the structural entity explorer is built from: source-location parsing, the
 * coverage presentation maps (four classes, never conflated), the flat-tree projection the windowed
 * ARIA tree renders, page merging, type-ahead, and the fetch envelope — plus the centered raw-viewer
 * line window added to `windowed-rows` for it.
 */

import { describe, expect, it, jest, afterEach } from '@jest/globals';

import {
  buildPreviewTreeRows,
  coverageDetailByEntityKey,
  defaultExpandedKeys,
  entityKindTag,
  fetchImportPreviewManifest,
  findTypeaheadIndex,
  mergeManifestPages,
  parseSourceLocation,
  previewEntityMatchesFilter,
  PREVIEW_COVERAGE_CLASSES,
  PREVIEW_COVERAGE_LABEL,
  PREVIEW_COVERAGE_TONE,
  PREVIEW_SECTION_KEYS,
  type ImportPreviewCoverageEntry,
  type ImportPreviewEntity,
  type ImportPreviewManifest,
} from '../src/app/utils/import-preview-manifest';
import { computeCenteredLineRange } from '../src/app/utils/windowed-rows';

/** Build an entity; each test overrides only the part it is about. */
function entity(overrides: Partial<ImportPreviewEntity> & { key: string }): ImportPreviewEntity {
  return {
    name: overrides.key,
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    deprecated: false,
    coverage: 'mapped',
    unmodeled_extras: [],
    ...overrides,
  };
}

/** A service with two operations, a channel, and two types — every tree shape at once. */
function fixtureEntities(): ImportPreviewEntity[] {
  return [
    entity({ key: 'svc:pets', name: 'PetService', entity_kind: 'service', order: 0, source_location: '3:1' }),
    entity({ key: 'op:listPets', name: 'listPets', entity_kind: 'operation', parent_key: 'svc:pets', order: 1, source_location: '7:3' }),
    entity({ key: 'op:getPet', name: 'getPet', entity_kind: 'operation', parent_key: 'svc:pets', order: 2, native_name: 'fetchPet' }),
    entity({ key: 'ch:petEvents', name: 'petEvents', entity_kind: 'channel', order: 3 }),
    entity({ key: 'type:Pet', name: 'Pet', entity_kind: 'type', order: 4, coverage: 'partially-mapped', unmodeled_extras: ['x-internal'] }),
    entity({ key: 'type:Owner', name: 'Owner', entity_kind: 'type', order: 5 }),
  ];
}

const FIXTURE_COUNTS = { services: 1, operations: 2, channels: 1, types: 2 };

function buildManifest(overrides: Partial<ImportPreviewManifest> = {}): ImportPreviewManifest {
  return {
    manifest_hash: 'hash-1',
    adapter: {
      adapter_key: 'graphql',
      adapter_label: 'GraphQL SDL',
      paradigm: 'graphql',
      formats: ['graphql'],
      capability: { format: 'graphql', mode: 'native', importable: true, related_issues: [] },
      parser_limits: [],
    },
    counts: FIXTURE_COUNTS,
    coverage_counts: { mapped: 4, 'partially-mapped': 1, 'unsupported-by-canonical-model': 0, 'not-parsed-by-adapter': 1 },
    status_counts: {},
    reason_counts: {},
    entities: fixtureEntities(),
    total_entities: 6,
    nodes: [],
    edges: [],
    coverage: [],
    total_coverage_entries: 0,
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

describe('parseSourceLocation', () => {
  it('parses "line:col"', () => {
    expect(parseSourceLocation('12:5')).toEqual({ line: 12, column: 5 });
  });

  it('accepts a bare line with column defaulting to 1', () => {
    expect(parseSourceLocation('12')).toEqual({ line: 12, column: 1 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSourceLocation(' 7:1 ')).toEqual({ line: 7, column: 1 });
  });

  it('degrades to null rather than a wrong line', () => {
    expect(parseSourceLocation('0:0')).toBeNull();
    expect(parseSourceLocation('3:0')).toBeNull();
    expect(parseSourceLocation('x')).toBeNull();
    expect(parseSourceLocation('1:2:3')).toBeNull();
    expect(parseSourceLocation('')).toBeNull();
    expect(parseSourceLocation(null)).toBeNull();
    expect(parseSourceLocation(undefined)).toBeNull();
  });
});

describe('coverage presentation maps', () => {
  it('gives each of the four classes a distinct label and a distinct tone', () => {
    const labels = PREVIEW_COVERAGE_CLASSES.map((c) => PREVIEW_COVERAGE_LABEL[c]);
    const tones = PREVIEW_COVERAGE_CLASSES.map((c) => PREVIEW_COVERAGE_TONE[c]);
    expect(new Set(labels).size).toBe(4);
    expect(new Set(tones).size).toBe(4);
  });

  it('never conflates "unsupported by canonical model" with "not parsed by adapter"', () => {
    // The backend keeps these verdicts distinct by design; the UI must not blur them.
    expect(PREVIEW_COVERAGE_LABEL['unsupported-by-canonical-model']).not.toBe(
      PREVIEW_COVERAGE_LABEL['not-parsed-by-adapter'],
    );
    expect(PREVIEW_COVERAGE_TONE['unsupported-by-canonical-model']).not.toBe(
      PREVIEW_COVERAGE_TONE['not-parsed-by-adapter'],
    );
    expect(PREVIEW_COVERAGE_LABEL['unsupported-by-canonical-model']).toMatch(/canonical/i);
    expect(PREVIEW_COVERAGE_LABEL['not-parsed-by-adapter']).toMatch(/adapter/i);
  });

  it('maps entity kinds onto the parsed-model tag vocabulary', () => {
    expect(entityKindTag('service')).toBe('SERVICE');
    expect(entityKindTag('operation')).toBe('OPERATION');
    expect(entityKindTag('channel')).toBe('CHANNEL');
    expect(entityKindTag('type')).toBe('TYPE');
  });
});

describe('buildPreviewTreeRows', () => {
  it('renders sections in Services/Channels/Types order with full-manifest counts', () => {
    const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), '');
    const sections = rows.filter((row) => row.kind === 'section');
    expect(sections.map((row) => row.label)).toEqual(['Services', 'Channels', 'Types']);
    expect(sections.map((row) => row.count)).toEqual([1, 1, 2]);
    expect(sections.map((row) => row.posInSet)).toEqual([1, 2, 3]);
    expect(sections.every((row) => row.setSize === 3 && row.depth === 1)).toBe(true);
  });

  it('collapses services by default, hiding their operations', () => {
    const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), '');
    expect(rows.map((row) => row.key)).toEqual([
      PREVIEW_SECTION_KEYS.services,
      'svc:pets',
      PREVIEW_SECTION_KEYS.channels,
      'ch:petEvents',
      PREVIEW_SECTION_KEYS.types,
      'type:Pet',
      'type:Owner',
    ]);
    const service = rows.find((row) => row.key === 'svc:pets')!;
    expect(service.hasChildren).toBe(true);
    expect(service.expanded).toBe(false);
    expect(service.depth).toBe(2);
  });

  it('nests operations at depth 3 with set positions once their service expands', () => {
    const expanded = defaultExpandedKeys();
    expanded.add('svc:pets');
    const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, expanded, '');
    const ops = rows.filter((row) => row.entity?.entity_kind === 'operation');
    expect(ops.map((row) => row.key)).toEqual(['op:listPets', 'op:getPet']);
    expect(ops.map((row) => row.depth)).toEqual([3, 3]);
    expect(ops.map((row) => row.posInSet)).toEqual([1, 2]);
    expect(ops.every((row) => row.setSize === 2)).toBe(true);
    // Operations sit directly after their service in the flat projection.
    expect(rows.findIndex((row) => row.key === 'op:listPets')).toBe(
      rows.findIndex((row) => row.key === 'svc:pets') + 1,
    );
  });

  it('omits empty sections but keeps one whose full count is non-zero mid-truncation', () => {
    const onlyTypes = fixtureEntities().filter((e) => e.entity_kind === 'type');
    const rows = buildPreviewTreeRows(onlyTypes, { types: 2 }, defaultExpandedKeys(), '');
    expect(rows.filter((row) => row.kind === 'section').map((row) => row.label)).toEqual(['Types']);

    // A truncated page can carry counts for kinds whose entities have not loaded yet — the
    // section still renders (with its count) so the kind is not silently hidden.
    const truncated = buildPreviewTreeRows(onlyTypes, { services: 3, types: 2 }, defaultExpandedKeys(), '');
    const services = truncated.find((row) => row.key === PREVIEW_SECTION_KEYS.services)!;
    expect(services.count).toBe(3);
    expect(services.hasChildren).toBe(false);
  });

  it('keeps an operation whose service is not loaded, as a Services-section child', () => {
    const orphan = entity({
      key: 'op:orphan',
      name: 'orphanOp',
      entity_kind: 'operation',
      parent_key: 'svc:not-loaded',
      order: 9,
    });
    const rows = buildPreviewTreeRows(
      [...fixtureEntities(), orphan],
      FIXTURE_COUNTS,
      defaultExpandedKeys(),
      '',
    );
    const row = rows.find((r) => r.key === 'op:orphan')!;
    expect(row.depth).toBe(2);
  });

  it('filters to matches plus their ancestors, force-expanding the tree', () => {
    // Services are collapsed by default; the filter must still reveal a matching operation.
    const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), 'listPets');
    expect(rows.map((row) => row.key)).toEqual([PREVIEW_SECTION_KEYS.services, 'svc:pets', 'op:listPets']);
    const service = rows.find((row) => row.key === 'svc:pets')!;
    expect(service.expanded).toBe(true);
  });

  it('matches on native (source) names too', () => {
    const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), 'fetchPet');
    expect(rows.some((row) => row.key === 'op:getPet')).toBe(true);
    expect(rows.some((row) => row.key === 'type:Pet')).toBe(false);
    expect(previewEntityMatchesFilter(fixtureEntities()[2], 'FETCH')).toBe(true);
  });

  it('returns no rows when nothing matches the filter', () => {
    expect(buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), 'zzz')).toEqual([]);
  });
});

describe('mergeManifestPages', () => {
  it('appends list fields and takes the cursor state from the new page', () => {
    const all = fixtureEntities();
    const base = buildManifest({ entities: all.slice(0, 3), next_cursor: 'c2', truncated: true });
    const next = buildManifest({ entities: all.slice(3), next_cursor: null, truncated: true });
    const merged = mergeManifestPages(base, next);
    expect(merged.entities.map((e) => e.key)).toEqual(all.map((e) => e.key));
    expect(merged.next_cursor).toBeNull();
    expect(merged.manifest_hash).toBe('hash-1');
  });

  it('restarts from the new page when the manifest hash rolled between requests', () => {
    const base = buildManifest({ entities: fixtureEntities().slice(0, 3), next_cursor: 'c2' });
    const next = buildManifest({ manifest_hash: 'hash-2', entities: fixtureEntities().slice(0, 1) });
    const merged = mergeManifestPages(base, next);
    expect(merged).toBe(next);
    expect(merged.entities).toHaveLength(1);
  });
});

describe('findTypeaheadIndex', () => {
  const rows = buildPreviewTreeRows(fixtureEntities(), FIXTURE_COUNTS, defaultExpandedKeys(), '');
  // Row labels: Services, PetService, Channels, petEvents, Types, Pet, Owner

  it('finds the next label starting with the buffer, searching after the current row', () => {
    expect(findTypeaheadIndex(rows, 0, 'pet')).toBe(1); // PetService
    expect(findTypeaheadIndex(rows, 1, 'pet')).toBe(3); // petEvents (case-insensitive)
  });

  it('wraps around and can land back on an earlier row', () => {
    expect(findTypeaheadIndex(rows, 5, 'pet')).toBe(1);
  });

  it('narrows with a multi-character buffer', () => {
    expect(findTypeaheadIndex(rows, 0, 'ow')).toBe(6); // Owner
  });

  it('returns null for an empty buffer or no match', () => {
    expect(findTypeaheadIndex(rows, 0, '')).toBeNull();
    expect(findTypeaheadIndex(rows, 0, 'zzz')).toBeNull();
    expect(findTypeaheadIndex([], 0, 'a')).toBeNull();
  });
});

describe('coverageDetailByEntityKey', () => {
  it('indexes entity-scoped rows, first row winning, skipping document-scoped rows', () => {
    const entries: ImportPreviewCoverageEntry[] = [
      { source_construct: 'doc', coverage: 'mapped', status: 'retained', detail: 'doc-level', entity_key: null, document_scoped: true },
      { source_construct: 'Pet', coverage: 'partially-mapped', status: 'approximated', detail: 'first', entity_key: 'type:Pet', document_scoped: false },
      { source_construct: 'Pet.x', coverage: 'partially-mapped', status: 'approximated', detail: 'second', entity_key: 'type:Pet', document_scoped: false },
    ];
    const byKey = coverageDetailByEntityKey(entries);
    expect(byKey.size).toBe(1);
    expect(byKey.get('type:Pet')?.detail).toBe('first');
  });
});

describe('fetchImportPreviewManifest', () => {
  afterEach(() => jest.restoreAllMocks());

  it('unwraps the proxy envelope and returns the response', async () => {
    const payload = { ok: true, preflight: { ok: true, policy: {} }, manifest: buildManifest() };
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...payload }) }),
    ) as unknown as typeof fetch;

    const result = await fetchImportPreviewManifest({ document_base64: 'abc', page_size: 1000 });
    expect(result.ok).toBe(true);
    expect(result.manifest?.manifest_hash).toBe('hash-1');
    const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/import/preview-manifest');
    expect(JSON.parse(String(init.body))).toMatchObject({ document_base64: 'abc', page_size: 1000 });
  });

  it('throws the proxy error on a failed transport', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'proxy down' }) }),
    ) as unknown as typeof fetch;
    await expect(fetchImportPreviewManifest({ document_base64: 'abc' })).rejects.toThrow('proxy down');
  });

  it('throws on an incomplete body rather than rendering garbage', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }),
    ) as unknown as typeof fetch;
    await expect(fetchImportPreviewManifest({ document_base64: 'abc' })).rejects.toThrow(
      'incomplete',
    );
  });
});

describe('computeCenteredLineRange', () => {
  it('mounts the head of the document when nothing is selected', () => {
    expect(computeCenteredLineRange(1000, null, 400)).toEqual({ start: 0, end: 400 });
  });

  it('centers the window on the selected line', () => {
    const range = computeCenteredLineRange(12000, 6000, 400);
    expect(range).toEqual({ start: 5799, end: 6199 });
    // The selected line (0-based 5999) sits inside the window.
    expect(range.start).toBeLessThanOrEqual(5999);
    expect(range.end).toBeGreaterThan(5999);
  });

  it('clamps at the start and end of the document', () => {
    expect(computeCenteredLineRange(1000, 1, 400)).toEqual({ start: 0, end: 400 });
    expect(computeCenteredLineRange(1000, 1000, 400)).toEqual({ start: 600, end: 1000 });
  });

  it('mounts the whole document when it is shorter than the window', () => {
    expect(computeCenteredLineRange(7, 450, 400)).toEqual({ start: 0, end: 7 });
    expect(computeCenteredLineRange(7, null, 400)).toEqual({ start: 0, end: 7 });
  });

  it('mounts nothing for degenerate inputs', () => {
    expect(computeCenteredLineRange(0, 5, 400)).toEqual({ start: 0, end: 0 });
    expect(computeCenteredLineRange(100, 5, 0)).toEqual({ start: 0, end: 0 });
  });
});
