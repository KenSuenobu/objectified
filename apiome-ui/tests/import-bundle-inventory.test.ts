/**
 * Import bundle inventory contract and file-tree projection (IXH-3.5, #5107).
 *
 * The DOM-free half of the bundle explorer's acceptance criteria:
 *
 *  1. **Transport contract** — a payload that is not a bundle and an archive that could not be
 *     unpacked both *resolve* (they are verdicts); only a real transport failure throws.
 *  2. **Page accumulation** — file pages append while the whole-bundle totals stay authoritative,
 *     and the first page's unresolved list is never overwritten by a later page.
 *  3. **File tree** — the flat, path-ordered file list projects onto the archive's own directory
 *     tree with correct ARIA level/setsize/posinset, count badges, expansion, and filtering.
 *  4. **Presentation maps** — every role, verdict, resolution, and ignore reason has distinct
 *     wording, and an unknown ignore reason degrades to itself rather than to a lie.
 */

import { describe, expect, it, jest, afterEach } from '@jest/globals';

import {
  BUNDLE_IGNORED_REASON_LABEL,
  BUNDLE_RESOLUTION_LABEL,
  BUNDLE_ROLES,
  BUNDLE_ROLE_HINT,
  BUNDLE_ROLE_LABEL,
  BUNDLE_ROLE_TONE,
  BUNDLE_VERDICT_LABEL,
  bundleAncestorKeys,
  bundleDirectoryKey,
  bundleFileMatchesFilter,
  bundleFilesByPath,
  bundleIgnoredReasonLabel,
  buildBundleTreeRows,
  defaultBundleExpandedKeys,
  fetchImportBundleInventory,
  formatBundleBytes,
  mergeBundlePages,
  type BundleFileEntry,
  type ImportBundleInventory,
} from '../src/app/utils/import-bundle-inventory';

function file(path: string, overrides: Partial<BundleFileEntry> = {}): BundleFileEntry {
  return {
    path,
    role: 'unreferenced',
    verdict: 'analysed',
    bytes: 128,
    lines: 8,
    ignored_reason: null,
    error: null,
    imports: [],
    imported_by: [],
    entity_keys: [],
    entity_count: 0,
    ...overrides,
  };
}

const FILES: BundleFileEntry[] = [
  file('README.md'),
  file('proto/user/types.proto', { role: 'dependency', imported_by: ['proto/user/user.proto'] }),
  file('proto/user/user.proto', { role: 'entry-point', entity_count: 2, entity_keys: ['a', 'b'] }),
  file('vendor/logo.png', { role: 'unreadable', verdict: 'not-analysed' }),
];

function inventory(overrides: Partial<ImportBundleInventory> = {}): ImportBundleInventory {
  return {
    entry_point: 'proto/user/user.proto',
    entry_point_pinned: false,
    entry_point_error: null,
    entry_point_candidates: [
      { path: 'proto/user/user.proto', format: 'protobuf', confidence: 0.97, selected: true },
    ],
    attribution: 'declaration-scan',
    files: FILES,
    total_files: FILES.length,
    role_counts: { 'entry-point': 1, dependency: 1, unreferenced: 1, ignored: 0, unreadable: 1 },
    verdict_counts: { analysed: 3, failed: 0, 'not-analysed': 1 },
    unresolved: [
      {
        from_path: 'proto/user/user.proto',
        directive: 'import',
        target: 'missing/gone.proto',
        to_path: null,
        resolution: 'unresolved',
        provider: null,
        search_paths: ['proto/user/missing/gone.proto', 'missing/gone.proto'],
        line: 4,
      },
    ],
    total_unresolved: 1,
    total_edges: 3,
    total_entities: 2,
    unattributed_entities: 0,
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchImportBundleInventory', () => {
  function mockJson(body: unknown, ok = true) {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok, json: () => Promise.resolve(body) }),
    ) as unknown as typeof fetch;
  }

  it('resolves a single-document verdict rather than throwing', async () => {
    mockJson({ success: true, ok: true, kind: 'single-document', inventory: null });

    const response = await fetchImportBundleInventory({ document_base64: 'x' });

    expect(response.kind).toBe('single-document');
    expect(response.inventory ?? null).toBeNull();
  });

  it('resolves an unusable archive as a verdict carrying the taxonomy error', async () => {
    mockJson({
      success: true,
      ok: false,
      kind: 'archive',
      inventory: null,
      error: { code: 'INPUT_ARCHIVE_INVALID', category: 'input', message: 'bad', remediation: 'fix', retriable: false },
    });

    const response = await fetchImportBundleInventory({ document_base64: 'x' });

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('INPUT_ARCHIVE_INVALID');
  });

  it('throws on a proxy failure', async () => {
    mockJson({ success: false, error: 'Not authenticated' }, false);

    await expect(fetchImportBundleInventory({ document_base64: 'x' })).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('throws when the response shape is incomplete', async () => {
    mockJson({ success: true });

    await expect(fetchImportBundleInventory({ document_base64: 'x' })).rejects.toThrow(
      /incomplete/,
    );
  });
});

describe('mergeBundlePages', () => {
  it('appends files while the whole-bundle totals stay authoritative', () => {
    const base = inventory({ files: [FILES[0]], next_cursor: 'c1', truncated: true, total_files: 4 });
    const next = inventory({
      files: [FILES[1], FILES[2]],
      next_cursor: null,
      truncated: false,
      total_files: 4,
      unresolved: [],
    });

    const merged = mergeBundlePages(base, next);

    expect(merged.files.map((entry) => entry.path)).toEqual([
      'README.md',
      'proto/user/types.proto',
      'proto/user/user.proto',
    ]);
    expect(merged.total_files).toBe(4);
    expect(merged.next_cursor).toBeNull();
    expect(merged.truncated).toBe(false);
  });

  it('keeps the first page’s unresolved list, which later pages do not carry', () => {
    const base = inventory();
    const next = inventory({ files: [], unresolved: [] });

    expect(mergeBundlePages(base, next).unresolved).toHaveLength(1);
  });
});

describe('buildBundleTreeRows', () => {
  it('projects the flat path list onto the archive’s directory tree', () => {
    const rows = buildBundleTreeRows(FILES, defaultBundleExpandedKeys(FILES), '');

    expect(rows.map((row) => `${row.depth}:${row.kind}:${row.label}`)).toEqual([
      '1:directory:proto',
      '2:directory:user',
      '3:file:types.proto',
      '3:file:user.proto',
      '1:directory:vendor',
      '2:file:logo.png',
      '1:file:README.md',
    ]);
  });

  it('counts the files at or below each directory row', () => {
    const rows = buildBundleTreeRows(FILES, defaultBundleExpandedKeys(FILES), '');
    const byLabel = new Map(rows.map((row) => [row.label, row]));

    expect(byLabel.get('proto')?.count).toBe(2);
    expect(byLabel.get('vendor')?.count).toBe(1);
    expect(byLabel.get('README.md')?.count).toBeNull();
  });

  it('gives every row correct ARIA level, setsize, and posinset', () => {
    const rows = buildBundleTreeRows(FILES, defaultBundleExpandedKeys(FILES), '');
    const root = rows.filter((row) => row.depth === 1);

    // Root level: proto/, vendor/, README.md — directories first, then files.
    expect(root.map((row) => row.posInSet)).toEqual([1, 2, 3]);
    expect(root.every((row) => row.setSize === 3)).toBe(true);
  });

  it('collapses a directory’s children when its key is not expanded', () => {
    const rows = buildBundleTreeRows(FILES, new Set([bundleDirectoryKey('vendor')]), '');

    expect(rows.map((row) => row.label)).toEqual(['proto', 'vendor', 'logo.png', 'README.md']);
    expect(rows.find((row) => row.label === 'proto')?.expanded).toBe(false);
  });

  it('force-expands while filtering and keeps only matches plus their ancestors', () => {
    const rows = buildBundleTreeRows(FILES, new Set(), 'types');

    expect(rows.map((row) => row.label)).toEqual(['proto', 'user', 'types.proto']);
  });

  it('renders nothing when no file matches the filter', () => {
    expect(buildBundleTreeRows(FILES, new Set(), 'nothing-matches-this')).toEqual([]);
  });
});

describe('filtering and helpers', () => {
  it('matches on path, role, verdict, and ignore reason', () => {
    const ignored = file('.DS_Store', {
      role: 'ignored',
      verdict: 'not-analysed',
      ignored_reason: 'os-metadata',
    });

    expect(bundleFileMatchesFilter(ignored, 'ds_store')).toBe(true);
    expect(bundleFileMatchesFilter(ignored, 'ignored')).toBe(true);
    expect(bundleFileMatchesFilter(ignored, 'not-analysed')).toBe(true);
    expect(bundleFileMatchesFilter(ignored, 'os-metadata')).toBe(true);
    expect(bundleFileMatchesFilter(ignored, 'proto')).toBe(false);
    expect(bundleFileMatchesFilter(ignored, '   ')).toBe(true);
  });

  it('lists the ancestor directory keys a file needs to become visible', () => {
    expect(bundleAncestorKeys('a/b/c.proto')).toEqual(['dir:a', 'dir:a/b']);
    expect(bundleAncestorKeys('top.proto')).toEqual([]);
  });

  it('indexes files by path', () => {
    expect(bundleFilesByPath(FILES).get('README.md')?.role).toBe('unreferenced');
  });

  it('formats byte counts without inventing precision', () => {
    expect(formatBundleBytes(0)).toBe('—');
    expect(formatBundleBytes(512)).toBe('512 B');
    expect(formatBundleBytes(2048)).toBe('2.0 kB');
    expect(formatBundleBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('presentation maps', () => {
  it('gives every role a distinct label, hint, and tone', () => {
    const labels = BUNDLE_ROLES.map((role) => BUNDLE_ROLE_LABEL[role]);
    const tones = BUNDLE_ROLES.map((role) => BUNDLE_ROLE_TONE[role]);

    expect(new Set(labels).size).toBe(BUNDLE_ROLES.length);
    expect(new Set(tones).size).toBe(BUNDLE_ROLES.length);
    expect(BUNDLE_ROLES.every((role) => BUNDLE_ROLE_HINT[role].length > 0)).toBe(true);
  });

  it('never conflates a resolved, a toolchain-provided, and an unresolved reference', () => {
    expect(new Set(Object.values(BUNDLE_RESOLUTION_LABEL)).size).toBe(3);
    expect(BUNDLE_RESOLUTION_LABEL.provided).toMatch(/toolchain/i);
  });

  it('gives every verdict a distinct label', () => {
    expect(new Set(Object.values(BUNDLE_VERDICT_LABEL)).size).toBe(3);
  });

  it('explains each stable ignore reason and shows an unknown one verbatim', () => {
    for (const reason of Object.keys(BUNDLE_IGNORED_REASON_LABEL)) {
      expect(bundleIgnoredReasonLabel(reason)).toBe(BUNDLE_IGNORED_REASON_LABEL[reason]);
    }
    expect(bundleIgnoredReasonLabel('a-reason-shipped-later')).toBe('a-reason-shipped-later');
    expect(bundleIgnoredReasonLabel(null)).toMatch(/excluded/i);
  });
});
