/**
 * Unit tests for the multi-file bundle model and the client-side ZIP reader (MFX-43.2, #4362).
 *
 * Covers the pure backbone of the bundle tree: manifest building + single/multi detection, folding
 * flat paths into a folder/file tree (folders first, alphabetical), bucketing Verify findings by
 * file (with folder roll-up), and reading files back out of a `buildZip` archive round-trip.
 */

import {
  aggregateFolderCounts,
  buildBundleManifest,
  buildBundleTree,
  bundleFileName,
  countFindingsByFile,
  flattenBundleTree,
  isMultiFileBundle,
  normalizeBundlePath,
  type BundleTreeFolderNode,
} from '../src/app/components/ade/dashboard/export/exportBundle';
import { buildZip, looksLikeZip, readZip } from '../src/app/components/ade/dashboard/export/zipBundle';

describe('buildBundleManifest', () => {
  it('computes UTF-8 sizes and takes the first file as primary', () => {
    const manifest = buildBundleManifest([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'google/protobuf/timestamp.proto', text: 'message Ts {}' },
    ]);
    expect(manifest.primaryPath).toBe('petstore.proto');
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0].sizeBytes).toBe('syntax = "proto3";'.length);
  });

  it('normalizes and de-duplicates paths (last write wins, order preserved)', () => {
    const manifest = buildBundleManifest([
      { path: './a/b.proto', text: 'first' },
      { path: 'a\\b.proto', text: 'second' },
    ]);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('a/b.proto');
    expect(manifest.files[0].text).toBe('second');
  });

  it('rejects an empty file list', () => {
    expect(() => buildBundleManifest([])).toThrow(/at least one file/);
  });
});

describe('isMultiFileBundle', () => {
  it('is false for a lone file and true for two or more', () => {
    expect(isMultiFileBundle(buildBundleManifest([{ path: 'a.json', text: '{}' }]))).toBe(false);
    expect(
      isMultiFileBundle(
        buildBundleManifest([
          { path: 'a.json', text: '{}' },
          { path: 'b.json', text: '{}' },
        ]),
      ),
    ).toBe(true);
  });
});

describe('normalizeBundlePath / bundleFileName', () => {
  it('normalizes separators and strips leading ./ and slashes', () => {
    expect(normalizeBundlePath('.\\a//b\\c.proto')).toBe('a/b/c.proto');
    expect(normalizeBundlePath('/x/y.json')).toBe('x/y.json');
  });

  it('takes the basename', () => {
    expect(bundleFileName('com/example/User.avsc')).toBe('User.avsc');
    expect(bundleFileName('root.proto')).toBe('root.proto');
  });
});

describe('buildBundleTree', () => {
  it('folds paths into folders-first, alphabetical order', () => {
    const manifest = buildBundleManifest([
      { path: 'petstore.proto', text: 'a' },
      { path: 'com/example/User.avsc', text: 'b' },
      { path: 'com/example/Order.avsc', text: 'c' },
      { path: 'com/acme/Thing.avsc', text: 'd' },
    ]);
    const tree = buildBundleTree(manifest.files);

    // Root: the `com` folder sorts before the `petstore.proto` file.
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['folder:com', 'file:petstore.proto']);

    const com = tree[0] as BundleTreeFolderNode;
    // Nested folders sort alphabetically (acme before example).
    expect(com.children.map((n) => n.name)).toEqual(['acme', 'example']);

    const example = com.children[1] as BundleTreeFolderNode;
    // Files within a folder sort alphabetically.
    expect(example.children.map((n) => n.name)).toEqual(['Order.avsc', 'User.avsc']);
    expect(example.children[0]).toMatchObject({ kind: 'file', path: 'com/example/Order.avsc' });
  });
});

describe('countFindingsByFile', () => {
  it('buckets validation as errors and lint by severity, keyed by file', () => {
    const counts = countFindingsByFile(
      [{ file: 'a.proto' }, { file: 'a.proto' }, { file: null }],
      [
        { file: 'a.proto', severity: 'warning' },
        { file: 'b.proto', severity: 'error' },
        { file: 'b.proto', severity: 'info' },
        { severity: 'error' },
      ],
    );
    expect(counts.get('a.proto')).toEqual({ errors: 2, warnings: 1 });
    expect(counts.get('b.proto')).toEqual({ errors: 1, warnings: 1 });
    // A location-less finding contributes to no file.
    expect(counts.size).toBe(2);
  });
});

describe('aggregateFolderCounts', () => {
  it('rolls per-file counts up to the enclosing folder', () => {
    const manifest = buildBundleManifest([
      { path: 'com/A.avsc', text: 'a' },
      { path: 'com/B.avsc', text: 'b' },
    ]);
    const tree = buildBundleTree(manifest.files);
    const counts = countFindingsByFile([{ file: 'com/A.avsc' }], [{ file: 'com/B.avsc', severity: 'warning' }]);

    const folder = tree[0];
    expect(aggregateFolderCounts(folder, counts)).toEqual({ errors: 1, warnings: 1 });
  });
});

describe('looksLikeZip', () => {
  it('detects a zip by content type or leading magic bytes', () => {
    expect(looksLikeZip(new Uint8Array([0]), 'application/zip')).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]), '')).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x7b, 0x7d]), 'application/json')).toBe(false);
  });
});

describe('readZip (round-trips buildZip)', () => {
  it('reads every stored file back out of the archive', async () => {
    const entries = [
      { path: 'petstore.proto', content: 'syntax = "proto3";' },
      { path: 'com/example/User.avsc', content: '{"type":"record"}' },
    ];
    const archive = buildZip(entries);
    expect(looksLikeZip(archive)).toBe(true);

    const files = await readZip(archive);
    expect(files).toEqual([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'com/example/User.avsc', text: '{"type":"record"}' },
    ]);
  });

  it('rejects a body that is not a zip', async () => {
    await expect(readZip(new Uint8Array([0x7b, 0x7d]))).rejects.toThrow(/ZIP/i);
  });
});

describe('flattenBundleTree (MFX-41.5)', () => {
  const nodes = buildBundleTree(
    buildBundleManifest([
      { path: 'petstore.proto', text: 'syntax = "proto3";' },
      { path: 'com/example/User.avsc', text: '{}' },
      { path: 'com/example/Order.avsc', text: '{}' },
    ]).files,
  );

  it('lists every visible row in render order with its ARIA coordinates', () => {
    const rows = flattenBundleTree(nodes, new Set());
    expect(rows.map((row) => row.node.path)).toEqual([
      'com',
      'com/example',
      'com/example/Order.avsc',
      'com/example/User.avsc',
      'petstore.proto',
    ]);
    // Folders sort first, so the root set is [com, petstore.proto].
    expect(rows[0]).toMatchObject({ depth: 1, setSize: 2, posInSet: 1, hasChildren: true, expanded: true, parentPath: null });
    expect(rows[2]).toMatchObject({ depth: 3, setSize: 2, posInSet: 1, hasChildren: false, parentPath: 'com/example' });
  });

  it('omits the descendants of a collapsed folder but keeps the folder itself', () => {
    const rows = flattenBundleTree(nodes, new Set(['com/example']));
    expect(rows.map((row) => row.node.path)).toEqual(['com', 'com/example', 'petstore.proto']);
    expect(rows[1]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('reports a childless tree as no rows', () => {
    expect(flattenBundleTree([], new Set())).toEqual([]);
  });
});
