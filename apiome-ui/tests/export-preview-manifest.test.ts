/**
 * Unit tests for the export preview manifest model (IXH-4.1, #5109).
 *
 * Pins the pure helpers behind the structural artifact explorer: page merging, the
 * flattened tree projection (sections, nesting, orphans, filtering, ARIA metadata),
 * the code → entity line resolution (innermost-wins), the selected entity's Monaco
 * decoration (clamped, never fabricated), and type-ahead.
 */

import { describe, expect, it } from '@jest/globals';
import {
  buildExportManifestRows,
  countEntitiesByKind,
  decorationsForEntity,
  defaultExportExpandedKeys,
  ENTITY_LINE_CLASS,
  entityAtLine,
  EXPORT_MANIFEST_SECTION_KEYS,
  exportEntityMatchesFilter,
  findExportTypeaheadIndex,
  mergeManifestEntityPages,
  normalizedLocationFile,
  type ExportManifestEntity,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';

/** One manifest entity with retained defaults. */
function entity(overrides: Partial<ExportManifestEntity>): ExportManifestEntity {
  return {
    key: 'Entity',
    name: 'Entity',
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    description: null,
    deprecated: false,
    status: 'retained',
    reason: null,
    severity: 'info',
    detail: 'carried faithfully',
    target_mapping: null,
    emitted: true,
    location: null,
    aggregated: false,
    reported: true,
    native_name: null,
    native_id: null,
    source_location: null,
    ...overrides,
  };
}

/** A service → operation, channel, type → field manifest with mixed statuses. */
function sampleEntities(): ExportManifestEntity[] {
  return [
    entity({ key: 'Users', name: 'Users', entity_kind: 'service', order: 0, aggregated: true }),
    entity({
      key: 'GET /users/{id}',
      name: 'getUser',
      entity_kind: 'operation',
      parent_key: 'Users',
      order: 1,
      location: { file: 'openapi.json', line: 9, pointer: '/paths/~1users~1{id}/get' },
    }),
    entity({
      key: 'user/signedup',
      name: 'user/signedup',
      entity_kind: 'channel',
      order: 2,
      status: 'dropped',
      reason: 'destination_unsupported',
      severity: 'warn',
      detail: 'the destination has no event channels',
      emitted: false,
    }),
    entity({
      key: 'User',
      name: 'User',
      entity_kind: 'type',
      order: 3,
      location: { file: 'openapi.json', line: 38, pointer: '/components/schemas/User' },
    }),
    entity({
      key: 'User.email',
      name: 'email',
      entity_kind: 'field',
      parent_key: 'User',
      order: 4,
      reported: false,
      location: { file: 'openapi.json', line: 49, pointer: '/components/schemas/User/properties/email' },
    }),
  ];
}

describe('mergeManifestEntityPages', () => {
  it('deduplicates by key and restores stable full-tree order', () => {
    const [service, op, channel, type, field] = sampleEntities();
    const merged = mergeManifestEntityPages([
      [type, field],
      [service, op, type], // re-walked page repeats the type
      [channel],
    ]);
    expect(merged.map((e) => e.key)).toEqual([
      'Users',
      'GET /users/{id}',
      'user/signedup',
      'User',
      'User.email',
    ]);
  });
});

describe('buildExportManifestRows', () => {
  it('projects sections → roots → children with ARIA metadata', () => {
    const rows = buildExportManifestRows(
      sampleEntities(),
      { services: 1, channels: 1, types: 1 },
      defaultExportExpandedKeys(),
      '',
    );
    // Sections are expanded by default; services/types are collapsed.
    expect(rows.map((row) => row.key)).toEqual([
      EXPORT_MANIFEST_SECTION_KEYS.services,
      'Users',
      EXPORT_MANIFEST_SECTION_KEYS.channels,
      'user/signedup',
      EXPORT_MANIFEST_SECTION_KEYS.types,
      'User',
    ]);
    const section = rows[0];
    expect(section).toMatchObject({ kind: 'section', depth: 1, setSize: 3, posInSet: 1, count: 1 });
    const service = rows[1];
    expect(service).toMatchObject({ depth: 2, hasChildren: true, expanded: false });
  });

  it('expands a parent to reveal its children at depth 3', () => {
    const expanded = defaultExportExpandedKeys();
    expanded.add('Users');
    expanded.add('User');
    const rows = buildExportManifestRows(
      sampleEntities(),
      { services: 1, channels: 1, types: 1 },
      expanded,
      '',
    );
    const keys = rows.map((row) => row.key);
    expect(keys).toContain('GET /users/{id}');
    expect(keys).toContain('User.email');
    const opRow = rows.find((row) => row.key === 'GET /users/{id}')!;
    expect(opRow).toMatchObject({ depth: 3, setSize: 1, posInSet: 1, hasChildren: false });
  });

  it('keeps an orphan child (parent not loaded) as a direct section child', () => {
    const orphan = entity({
      key: 'Ghost.name',
      name: 'name',
      entity_kind: 'field',
      parent_key: 'Ghost', // its type is on an unloaded page
      order: 9,
    });
    const rows = buildExportManifestRows([orphan], null, defaultExportExpandedKeys(), '');
    const row = rows.find((r) => r.key === 'Ghost.name');
    expect(row).toBeDefined();
    expect(row!.depth).toBe(2);
  });

  it('filtering force-expands and keeps matches plus their ancestors', () => {
    const rows = buildExportManifestRows(
      sampleEntities(),
      { services: 1, channels: 1, types: 1 },
      defaultExportExpandedKeys(), // nothing but sections expanded — filter overrides
      'email',
    );
    const keys = rows.map((row) => row.key);
    expect(keys).toContain('User.email'); // the match
    expect(keys).toContain('User'); // its ancestor
    expect(keys).not.toContain('user/signedup');
  });

  it('filters by status so "dropped" surfaces every loss', () => {
    const rows = buildExportManifestRows(
      sampleEntities(),
      { services: 1, channels: 1, types: 1 },
      defaultExportExpandedKeys(),
      'dropped',
    );
    const entityKeys = rows.filter((row) => row.kind === 'entity').map((row) => row.key);
    expect(entityKeys).toEqual(['user/signedup']);
  });

  it('a section with a non-zero full count survives even with no loaded children', () => {
    const rows = buildExportManifestRows(
      [entity({ key: 'User', entity_kind: 'type', order: 0 })],
      { services: 5, channels: 0, types: 1 },
      defaultExportExpandedKeys(),
      '',
    );
    // Truncation cannot silently hide the Services kind: its count says rows exist.
    expect(rows.some((row) => row.key === EXPORT_MANIFEST_SECTION_KEYS.services)).toBe(true);
    expect(rows.some((row) => row.key === EXPORT_MANIFEST_SECTION_KEYS.channels)).toBe(false);
  });
});

describe('exportEntityMatchesFilter', () => {
  it('matches name, key, kind, status, and reason case-insensitively', () => {
    const channel = sampleEntities()[2];
    expect(exportEntityMatchesFilter(channel, 'SIGNED')).toBe(true);
    expect(exportEntityMatchesFilter(channel, 'channel')).toBe(true);
    expect(exportEntityMatchesFilter(channel, 'dropped')).toBe(true);
    expect(exportEntityMatchesFilter(channel, 'destination_unsupported')).toBe(true);
    expect(exportEntityMatchesFilter(channel, 'nomatch')).toBe(false);
    expect(exportEntityMatchesFilter(channel, '')).toBe(true);
  });
});

describe('entityAtLine (code → entity)', () => {
  it('resolves the declaration at-or-above the clicked line in the right file', () => {
    const entities = sampleEntities();
    expect(entityAtLine(entities, 'openapi.json', 40)?.key).toBe('User'); // between 38 and 49
    expect(entityAtLine(entities, 'openapi.json', 60)?.key).toBe('User.email'); // past the last
    expect(entityAtLine(entities, 'openapi.json', 9)?.key).toBe('GET /users/{id}');
    expect(entityAtLine(entities, 'openapi.json', 5)).toBeNull(); // above every declaration
    expect(entityAtLine(entities, 'other.json', 40)).toBeNull(); // wrong file
  });

  it('prefers the deeper kind when two declarations share a line', () => {
    const type = entity({
      key: 'User',
      entity_kind: 'type',
      order: 0,
      location: { file: 'a.json', line: 3, pointer: null },
    });
    const field = entity({
      key: 'User.email',
      name: 'email',
      entity_kind: 'field',
      parent_key: 'User',
      order: 1,
      location: { file: 'a.json', line: 3, pointer: null },
    });
    expect(entityAtLine([type, field], 'a.json', 3)?.key).toBe('User.email');
  });

  it('normalizes bundle paths on both sides', () => {
    const typed = entity({
      key: 'User',
      order: 0,
      location: { file: './openapi.json', line: 2, pointer: null },
    });
    expect(normalizedLocationFile(typed)).toBe('openapi.json');
    expect(entityAtLine([typed], 'openapi.json', 5)?.key).toBe('User');
  });
});

describe('decorationsForEntity (entity → code)', () => {
  it('decorates the declaration line whole-line, clamped to the document', () => {
    const selected = entity({
      key: 'User',
      order: 0,
      location: { file: 'a.json', line: 99, pointer: null },
    });
    const decorations = decorationsForEntity(selected, 'line1\nline2\nline3');
    expect(decorations).toHaveLength(1);
    expect(decorations[0].range).toMatchObject({ startLineNumber: 3, endLineNumber: 3 });
    expect(decorations[0].options).toMatchObject({ isWholeLine: true, className: ENTITY_LINE_CLASS });
  });

  it('decorates nothing without a resolvable line — no fabricated positions', () => {
    expect(decorationsForEntity(null, 'text')).toEqual([]);
    expect(decorationsForEntity(entity({ location: null }), 'text')).toEqual([]);
    expect(
      decorationsForEntity(entity({ location: { file: 'a.json', line: null, pointer: '/x' } }), 'text'),
    ).toEqual([]);
  });
});

describe('findExportTypeaheadIndex', () => {
  it('wraps around, starts after the current index, and is case-insensitive', () => {
    const rows = buildExportManifestRows(
      sampleEntities(),
      { services: 1, channels: 1, types: 1 },
      defaultExportExpandedKeys(),
      '',
    );
    const usersIndex = rows.findIndex((row) => row.key === 'Users');
    expect(findExportTypeaheadIndex(rows, rows.length - 1, 'us')).toBe(usersIndex);
    expect(findExportTypeaheadIndex(rows, usersIndex, 'us')).toBe(
      rows.findIndex((row) => row.key === 'user/signedup'),
    );
    expect(findExportTypeaheadIndex(rows, 0, '')).toBeNull();
    expect(findExportTypeaheadIndex(rows, 0, 'zzz')).toBeNull();
  });
});

describe('countEntitiesByKind', () => {
  it('counts root kinds for the section badges', () => {
    expect(countEntitiesByKind(sampleEntities())).toEqual({ services: 1, channels: 1, types: 1 });
  });
});
